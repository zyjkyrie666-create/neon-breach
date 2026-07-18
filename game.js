(() => {
  "use strict";

  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  const CONFIG = Object.freeze({
    width: 1280,
    height: 720,
    tile: 40,
    cols: 32,
    rows: 18,
    fixedStep: 1 / 60,
    storageKey: "neon-breach-level-v1",
    scoreKey: "neon-breach-high-score",
  });

  const COLORS = Object.freeze({
    cyan: "#39e7ff",
    blue: "#4e78ff",
    violet: "#a56cff",
    orange: "#ff9e54",
    red: "#ff4d70",
    green: "#62f5ad",
    text: "#eaf4ff",
    muted: "#72839e",
  });

  const ENEMY_STATS = Object.freeze({
    drone: { radius: 14, hp: 30, speed: 102, damage: 10, score: 100, color: COLORS.red },
    shooter: { radius: 17, hp: 46, speed: 72, damage: 8, score: 150, color: COLORS.violet },
    tank: { radius: 23, hp: 115, speed: 47, damage: 18, score: 260, color: COLORS.orange },
  });

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, amount) => a + (b - a) * amount;
  const randomRange = (min, max) => min + Math.random() * (max - min);
  const distanceSquared = (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };
  const circlesOverlap = (a, b) => {
    const radius = a.radius + b.radius;
    return distanceSquared(a, b) <= radius * radius;
  };
  const padScore = (value) => Math.floor(value).toString().padStart(6, "0");

  function safeStorageGet(key, fallback = null) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  class InputManager {
    constructor(targetCanvas) {
      this.keys = new Set();
      this.pressed = new Set();
      this.mouse = {
        x: CONFIG.width / 2,
        y: CONFIG.height / 2,
        down: false,
        clicked: false,
        rightClicked: false,
      };

      window.addEventListener("keydown", (event) => {
        const tagName = document.activeElement?.tagName;
        if (tagName === "TEXTAREA" || tagName === "INPUT") return;
        if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
          event.preventDefault();
        }
        if (!this.keys.has(event.code)) this.pressed.add(event.code);
        this.keys.add(event.code);
      });

      window.addEventListener("keyup", (event) => {
        this.keys.delete(event.code);
      });

      window.addEventListener("blur", () => {
        this.keys.clear();
        this.pressed.clear();
        this.mouse.down = false;
      });

      const updateMousePosition = (event) => {
        const rect = targetCanvas.getBoundingClientRect();
        this.mouse.x = clamp(((event.clientX - rect.left) / rect.width) * CONFIG.width, 0, CONFIG.width);
        this.mouse.y = clamp(((event.clientY - rect.top) / rect.height) * CONFIG.height, 0, CONFIG.height);
      };

      targetCanvas.addEventListener("pointermove", updateMousePosition);
      targetCanvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 && event.button !== 2) return;
        updateMousePosition(event);
        if (event.button === 0) {
          this.mouse.down = true;
          this.mouse.clicked = true;
        } else {
          this.mouse.rightClicked = true;
        }
        targetCanvas.setPointerCapture?.(event.pointerId);
      });
      window.addEventListener("pointerup", (event) => {
        if (event.button === 0) this.mouse.down = false;
      });
      targetCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
    }

    isDown(code) {
      return this.keys.has(code);
    }

    consume(code) {
      if (!this.pressed.has(code)) return false;
      this.pressed.delete(code);
      return true;
    }

    consumeClick() {
      if (!this.mouse.clicked) return false;
      this.mouse.clicked = false;
      return true;
    }

    consumeRightClick() {
      if (!this.mouse.rightClicked) return false;
      this.mouse.rightClicked = false;
      return true;
    }
  }

  class SoundManager {
    constructor() {
      this.enabled = true;
      this.context = null;
    }

    ensureContext() {
      if (!this.enabled) return null;
      if (!this.context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) this.context = new AudioContext();
      }
      if (this.context?.state === "suspended") this.context.resume();
      return this.context;
    }

    tone(frequency, duration, volume, type = "sine", slide = 0) {
      const audio = this.ensureContext();
      if (!audio) return;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const now = audio.currentTime;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now);
      if (slide) oscillator.frequency.exponentialRampToValueAtTime(Math.max(35, frequency + slide), now + duration);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(now);
      oscillator.stop(now + duration);
    }

    shoot() { this.tone(230, 0.045, 0.025, "square", 180); }
    hit() { this.tone(120, 0.04, 0.018, "sawtooth", -35); }
    enemyShoot() { this.tone(145, 0.08, 0.018, "triangle", -45); }
    dash() { this.tone(90, 0.12, 0.03, "sawtooth", 230); }
    destroy() { this.tone(75, 0.14, 0.035, "square", -25); }
    playerHit() { this.tone(65, 0.2, 0.055, "sawtooth", -20); }
    wave() { this.tone(330, 0.22, 0.035, "triangle", 280); }

    toggle() {
      this.enabled = !this.enabled;
      if (this.enabled) this.tone(440, 0.08, 0.025, "sine", 100);
      return this.enabled;
    }
  }

  class ObjectPool {
    constructor(factory, initialSize = 0) {
      this.factory = factory;
      this.items = [];
      this.created = 0;
      this.reused = 0;
      for (let index = 0; index < initialSize; index += 1) {
        const item = this.factory();
        item.active = false;
        this.items.push(item);
        this.created += 1;
      }
    }

    acquire() {
      for (const item of this.items) {
        if (!item.active) {
          item.active = true;
          this.reused += 1;
          return item;
        }
      }
      const item = this.factory();
      item.active = true;
      this.items.push(item);
      this.created += 1;
      return item;
    }

    release(item) {
      item.active = false;
    }

    clear() {
      for (const item of this.items) item.active = false;
    }

    countActive() {
      let count = 0;
      for (const item of this.items) if (item.active) count += 1;
      return count;
    }

    reuseRatio() {
      const total = this.created + this.reused;
      return total ? this.reused / total : 0;
    }
  }

  class SpatialHash {
    constructor(cellSize = 80) {
      this.cellSize = cellSize;
      this.buckets = new Map();
    }

    clear() {
      this.buckets.clear();
    }

    key(col, row) {
      return `${col},${row}`;
    }

    insert(entity) {
      const col = Math.floor(entity.x / this.cellSize);
      const row = Math.floor(entity.y / this.cellSize);
      const key = this.key(col, row);
      if (!this.buckets.has(key)) this.buckets.set(key, []);
      this.buckets.get(key).push(entity);
    }

    query(x, y, radius) {
      const results = [];
      const minCol = Math.floor((x - radius) / this.cellSize);
      const maxCol = Math.floor((x + radius) / this.cellSize);
      const minRow = Math.floor((y - radius) / this.cellSize);
      const maxRow = Math.floor((y + radius) / this.cellSize);
      for (let row = minRow; row <= maxRow; row += 1) {
        for (let col = minCol; col <= maxCol; col += 1) {
          const bucket = this.buckets.get(this.key(col, row));
          if (bucket) results.push(...bucket);
        }
      }
      return results;
    }
  }

  class MapManager {
    constructor() {
      this.staticLayer = document.createElement("canvas");
      this.staticLayer.width = CONFIG.width;
      this.staticLayer.height = CONFIG.height;
      this.staticContext = this.staticLayer.getContext("2d");
      const saved = safeStorageGet(CONFIG.storageKey);
      let loaded = false;
      if (saved) {
        try {
          loaded = this.applyData(JSON.parse(saved), false);
        } catch (_error) {
          loaded = false;
        }
      }
      if (!loaded) this.applyData(this.createDefaultData(), false);
      this.rebuildStaticLayer();
    }

    createDefaultData() {
      const tiles = Array.from({ length: CONFIG.rows }, () => Array(CONFIG.cols).fill(0));
      for (let col = 0; col < CONFIG.cols; col += 1) {
        tiles[0][col] = 1;
        tiles[CONFIG.rows - 1][col] = 1;
      }
      for (let row = 0; row < CONFIG.rows; row += 1) {
        tiles[row][0] = 1;
        tiles[row][CONFIG.cols - 1] = 1;
      }

      const wallCells = [
        [6, 4], [7, 4], [8, 4], [23, 4], [24, 4], [25, 4],
        [6, 13], [7, 13], [8, 13], [23, 13], [24, 13], [25, 13],
        [13, 7], [14, 7], [17, 7], [18, 7],
        [13, 10], [14, 10], [17, 10], [18, 10],
        [4, 8], [4, 9], [27, 8], [27, 9],
      ];
      for (const [col, row] of wallCells) tiles[row][col] = 1;

      return {
        version: 1,
        cols: CONFIG.cols,
        rows: CONFIG.rows,
        tiles,
        playerSpawn: { col: 16, row: 9 },
        enemySpawns: [
          { col: 2, row: 2 },
          { col: 29, row: 2 },
          { col: 2, row: 15 },
          { col: 29, row: 15 },
          { col: 16, row: 2 },
          { col: 16, row: 15 },
        ],
      };
    }

    isValidData(data) {
      return Boolean(
        data &&
        data.cols === CONFIG.cols &&
        data.rows === CONFIG.rows &&
        Array.isArray(data.tiles) &&
        data.tiles.length === CONFIG.rows &&
        data.tiles.every((row) => Array.isArray(row) && row.length === CONFIG.cols) &&
        data.playerSpawn &&
        Array.isArray(data.enemySpawns),
      );
    }

    applyData(data, save = true) {
      if (!this.isValidData(data)) return false;
      this.tiles = data.tiles.map((row) => row.map((tile) => (tile === 1 ? 1 : 0)));
      this.playerSpawn = {
        col: clamp(Math.floor(data.playerSpawn.col), 1, CONFIG.cols - 2),
        row: clamp(Math.floor(data.playerSpawn.row), 1, CONFIG.rows - 2),
      };
      this.enemySpawns = data.enemySpawns
        .map((spawn) => ({
          col: clamp(Math.floor(spawn.col), 1, CONFIG.cols - 2),
          row: clamp(Math.floor(spawn.row), 1, CONFIG.rows - 2),
        }))
        .filter((spawn, index, list) =>
          list.findIndex((item) => item.col === spawn.col && item.row === spawn.row) === index,
        );
      if (!this.enemySpawns.length) this.enemySpawns.push({ col: 2, row: 2 });
      this.tiles[this.playerSpawn.row][this.playerSpawn.col] = 0;
      for (const spawn of this.enemySpawns) this.tiles[spawn.row][spawn.col] = 0;
      this.rebuildStaticLayer();
      if (save) this.save();
      return true;
    }

    serialize() {
      return {
        version: 1,
        cols: CONFIG.cols,
        rows: CONFIG.rows,
        tiles: this.tiles.map((row) => [...row]),
        playerSpawn: { ...this.playerSpawn },
        enemySpawns: this.enemySpawns.map((spawn) => ({ ...spawn })),
      };
    }

    save() {
      return safeStorageSet(CONFIG.storageKey, JSON.stringify(this.serialize()));
    }

    reset() {
      this.applyData(this.createDefaultData());
    }

    getWorldPosition(cell) {
      return {
        x: cell.col * CONFIG.tile + CONFIG.tile / 2,
        y: cell.row * CONFIG.tile + CONFIG.tile / 2,
      };
    }

    isWall(col, row) {
      if (col < 0 || row < 0 || col >= CONFIG.cols || row >= CONFIG.rows) return true;
      return this.tiles[row][col] === 1;
    }

    circleCollides(x, y, radius) {
      const minCol = Math.floor((x - radius) / CONFIG.tile);
      const maxCol = Math.floor((x + radius) / CONFIG.tile);
      const minRow = Math.floor((y - radius) / CONFIG.tile);
      const maxRow = Math.floor((y + radius) / CONFIG.tile);

      for (let row = minRow; row <= maxRow; row += 1) {
        for (let col = minCol; col <= maxCol; col += 1) {
          if (!this.isWall(col, row)) continue;
          const left = col * CONFIG.tile;
          const top = row * CONFIG.tile;
          const nearestX = clamp(x, left, left + CONFIG.tile);
          const nearestY = clamp(y, top, top + CONFIG.tile);
          const dx = x - nearestX;
          const dy = y - nearestY;
          if (dx * dx + dy * dy < radius * radius) return true;
        }
      }
      return false;
    }

    moveCircle(entity, dx, dy) {
      const nextX = entity.x + dx;
      if (!this.circleCollides(nextX, entity.y, entity.radius)) entity.x = nextX;
      const nextY = entity.y + dy;
      if (!this.circleCollides(entity.x, nextY, entity.radius)) entity.y = nextY;
    }

    editCell(col, row, tool) {
      if (col <= 0 || row <= 0 || col >= CONFIG.cols - 1 || row >= CONFIG.rows - 1) return false;
      const sameCell = (cell) => cell.col === col && cell.row === row;
      let changed = false;

      if (tool === "wall") {
        if (sameCell(this.playerSpawn)) return false;
        changed = this.tiles[row][col] !== 1 || this.enemySpawns.some(sameCell);
        this.tiles[row][col] = 1;
        this.enemySpawns = this.enemySpawns.filter((spawn) => !sameCell(spawn));
      } else if (tool === "erase") {
        if (sameCell(this.playerSpawn)) return false;
        changed = this.tiles[row][col] === 1 || this.enemySpawns.some(sameCell);
        this.tiles[row][col] = 0;
        this.enemySpawns = this.enemySpawns.filter((spawn) => !sameCell(spawn));
      } else if (tool === "enemy") {
        changed = this.tiles[row][col] === 1 || !this.enemySpawns.some(sameCell);
        this.tiles[row][col] = 0;
        if (!this.enemySpawns.some(sameCell)) this.enemySpawns.push({ col, row });
      } else if (tool === "player") {
        changed = !sameCell(this.playerSpawn) || this.tiles[row][col] === 1 || this.enemySpawns.some(sameCell);
        this.tiles[row][col] = 0;
        this.playerSpawn = { col, row };
        this.enemySpawns = this.enemySpawns.filter((spawn) => !sameCell(spawn));
      } else {
        return false;
      }

      if (!changed) return false;
      this.rebuildStaticLayer();
      this.save();
      return true;
    }

    rebuildStaticLayer() {
      if (!this.tiles) return;
      const layer = this.staticContext;
      const background = layer.createLinearGradient(0, 0, CONFIG.width, CONFIG.height);
      background.addColorStop(0, "#09101d");
      background.addColorStop(0.55, "#080d18");
      background.addColorStop(1, "#0a101c");
      layer.fillStyle = background;
      layer.fillRect(0, 0, CONFIG.width, CONFIG.height);

      layer.strokeStyle = "rgba(87, 117, 164, 0.07)";
      layer.lineWidth = 1;
      layer.beginPath();
      for (let col = 0; col <= CONFIG.cols; col += 1) {
        const x = col * CONFIG.tile + 0.5;
        layer.moveTo(x, 0);
        layer.lineTo(x, CONFIG.height);
      }
      for (let row = 0; row <= CONFIG.rows; row += 1) {
        const y = row * CONFIG.tile + 0.5;
        layer.moveTo(0, y);
        layer.lineTo(CONFIG.width, y);
      }
      layer.stroke();

      for (let row = 0; row < CONFIG.rows; row += 1) {
        for (let col = 0; col < CONFIG.cols; col += 1) {
          if (!this.isWall(col, row)) continue;
          const x = col * CONFIG.tile;
          const y = row * CONFIG.tile;
          const wallGradient = layer.createLinearGradient(x, y, x + CONFIG.tile, y + CONFIG.tile);
          wallGradient.addColorStop(0, "#1b2942");
          wallGradient.addColorStop(1, "#101827");
          layer.fillStyle = wallGradient;
          layer.fillRect(x + 2, y + 2, CONFIG.tile - 4, CONFIG.tile - 4);
          layer.strokeStyle = "rgba(83, 132, 213, 0.32)";
          layer.strokeRect(x + 4.5, y + 4.5, CONFIG.tile - 9, CONFIG.tile - 9);
          layer.fillStyle = "rgba(57, 231, 255, 0.2)";
          layer.fillRect(x + 5, y + 5, 8, 2);
          layer.fillRect(x + 5, y + 5, 2, 8);
          layer.fillStyle = "rgba(0, 0, 0, 0.22)";
          layer.fillRect(x + 7, y + CONFIG.tile - 7, CONFIG.tile - 14, 2);
        }
      }

      const vignette = layer.createRadialGradient(
        CONFIG.width / 2,
        CONFIG.height / 2,
        120,
        CONFIG.width / 2,
        CONFIG.height / 2,
        760,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,0.32)");
      layer.fillStyle = vignette;
      layer.fillRect(0, 0, CONFIG.width, CONFIG.height);
    }

    render(target) {
      target.drawImage(this.staticLayer, 0, 0);
    }

    renderEditorMarkers(target) {
      target.save();
      for (const spawn of this.enemySpawns) {
        const position = this.getWorldPosition(spawn);
        target.strokeStyle = COLORS.red;
        target.fillStyle = "rgba(255, 77, 112, 0.12)";
        target.lineWidth = 2;
        target.beginPath();
        target.arc(position.x, position.y, 12, 0, Math.PI * 2);
        target.fill();
        target.stroke();
        target.beginPath();
        target.moveTo(position.x - 6, position.y);
        target.lineTo(position.x + 6, position.y);
        target.moveTo(position.x, position.y - 6);
        target.lineTo(position.x, position.y + 6);
        target.stroke();
      }

      const player = this.getWorldPosition(this.playerSpawn);
      target.translate(player.x, player.y);
      target.rotate(Math.PI / 4);
      target.fillStyle = "rgba(57, 231, 255, 0.17)";
      target.strokeStyle = COLORS.cyan;
      target.fillRect(-10, -10, 20, 20);
      target.strokeRect(-10, -10, 20, 20);
      target.restore();
    }
  }

  class Particle {
    constructor() {
      this.active = false;
    }

    reset(x, y, color, options = {}) {
      this.x = x;
      this.y = y;
      this.vx = options.vx ?? randomRange(-90, 90);
      this.vy = options.vy ?? randomRange(-90, 90);
      this.size = options.size ?? randomRange(1.5, 4.5);
      this.life = options.life ?? randomRange(0.18, 0.5);
      this.maxLife = this.life;
      this.color = color;
      this.drag = options.drag ?? 0.92;
      this.active = true;
    }

    update(dt) {
      this.life -= dt;
      if (this.life <= 0) {
        this.active = false;
        return;
      }
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vx *= this.drag;
      this.vy *= this.drag;
    }

    render(target) {
      const alpha = clamp(this.life / this.maxLife, 0, 1);
      target.save();
      target.globalAlpha = alpha;
      target.fillStyle = this.color;
      target.shadowColor = this.color;
      target.shadowBlur = 10;
      target.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
      target.restore();
    }
  }

  class FloatingText {
    constructor() {
      this.active = false;
    }

    reset(x, y, text, color = COLORS.text, size = 14) {
      this.x = x;
      this.y = y;
      this.text = text;
      this.color = color;
      this.size = size;
      this.life = 0.65;
      this.maxLife = this.life;
      this.active = true;
    }

    update(dt) {
      this.life -= dt;
      this.y -= 28 * dt;
      if (this.life <= 0) this.active = false;
    }

    render(target) {
      target.save();
      target.globalAlpha = clamp(this.life / this.maxLife, 0, 1);
      target.fillStyle = this.color;
      target.font = `700 ${this.size}px Consolas, monospace`;
      target.textAlign = "center";
      target.shadowColor = this.color;
      target.shadowBlur = 8;
      target.fillText(this.text, this.x, this.y);
      target.restore();
    }
  }

  class Bullet {
    constructor(game) {
      this.game = game;
      this.active = false;
      this.radius = 4;
    }

    reset(x, y, angle, team, options = {}) {
      const speed = options.speed ?? (team === "player" ? 700 : 330);
      this.x = x;
      this.y = y;
      this.previousX = x;
      this.previousY = y;
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
      this.team = team;
      this.damage = options.damage ?? (team === "player" ? 18 : 8);
      this.radius = options.radius ?? (team === "player" ? 4 : 5);
      this.color = options.color ?? (team === "player" ? COLORS.cyan : COLORS.violet);
      this.life = options.life ?? 1.5;
      this.active = true;
    }

    update(dt) {
      this.previousX = this.x;
      this.previousY = this.y;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.life -= dt;

      if (
        this.life <= 0 ||
        this.x < -20 || this.y < -20 ||
        this.x > CONFIG.width + 20 || this.y > CONFIG.height + 20 ||
        this.game.map.circleCollides(this.x, this.y, this.radius)
      ) {
        this.active = false;
        return;
      }

      if (Math.random() < 0.42) {
        this.game.spawnParticle(this.x, this.y, this.color, {
          vx: -this.vx * 0.04,
          vy: -this.vy * 0.04,
          size: 2,
          life: 0.16,
        });
      }

      if (this.team === "player") {
        const candidates = this.game.enemyHash.query(this.x, this.y, this.radius + 28);
        this.game.stats.collisionCandidates += candidates.length;
        for (const enemy of candidates) {
          if (!enemy.active || !circlesOverlap(this, enemy)) continue;
          enemy.takeDamage(this.damage);
          this.game.spawnBurst(this.x, this.y, this.color, 4, 80);
          this.active = false;
          break;
        }
      } else if (this.game.player.active && circlesOverlap(this, this.game.player)) {
        this.game.player.takeDamage(this.damage);
        this.active = false;
      }
    }

    render(target) {
      target.save();
      target.strokeStyle = this.color;
      target.lineWidth = this.radius * 1.2;
      target.lineCap = "round";
      target.shadowColor = this.color;
      target.shadowBlur = 13;
      target.beginPath();
      target.moveTo(this.previousX, this.previousY);
      target.lineTo(this.x, this.y);
      target.stroke();
      target.restore();
    }
  }

  class Player {
    constructor(game) {
      this.game = game;
      this.radius = 15;
      this.active = false;
    }

    reset(spawn) {
      this.x = spawn.x;
      this.y = spawn.y;
      this.hp = 100;
      this.maxHp = 100;
      this.speed = 238;
      this.angle = 0;
      this.fireCooldown = 0;
      this.dashCooldown = 0;
      this.dashTime = 0;
      this.invulnerableTime = 0;
      this.hitFlash = 0;
      this.active = true;
    }

    update(dt) {
      const input = this.game.input;
      const rawX = (input.isDown("KeyD") || input.isDown("ArrowRight") ? 1 : 0) -
        (input.isDown("KeyA") || input.isDown("ArrowLeft") ? 1 : 0);
      const rawY = (input.isDown("KeyS") || input.isDown("ArrowDown") ? 1 : 0) -
        (input.isDown("KeyW") || input.isDown("ArrowUp") ? 1 : 0);
      const magnitude = Math.hypot(rawX, rawY) || 1;
      const moveX = rawX / magnitude;
      const moveY = rawY / magnitude;

      this.angle = Math.atan2(input.mouse.y - this.y, input.mouse.x - this.x);
      this.fireCooldown -= dt;
      this.dashCooldown -= dt;
      this.invulnerableTime -= dt;
      this.hitFlash -= dt;

      if (input.consume("Space") && this.dashCooldown <= 0) {
        const hasMovement = rawX !== 0 || rawY !== 0;
        this.dashDirectionX = hasMovement ? moveX : Math.cos(this.angle);
        this.dashDirectionY = hasMovement ? moveY : Math.sin(this.angle);
        this.dashTime = 0.16;
        this.dashCooldown = 1.45;
        this.invulnerableTime = 0.2;
        this.game.sound.dash();
        this.game.shake = Math.max(this.game.shake, 5);
      }

      if (this.dashTime > 0) {
        this.dashTime -= dt;
        this.game.map.moveCircle(this, this.dashDirectionX * 790 * dt, this.dashDirectionY * 790 * dt);
        this.game.spawnParticle(this.x, this.y, COLORS.cyan, {
          vx: randomRange(-35, 35),
          vy: randomRange(-35, 35),
          size: randomRange(4, 8),
          life: 0.25,
        });
      } else {
        this.game.map.moveCircle(this, moveX * this.speed * dt, moveY * this.speed * dt);
      }

      if ((input.mouse.down || input.isDown("KeyJ")) && this.fireCooldown <= 0) {
        this.shoot();
      }
    }

    shoot() {
      const muzzleDistance = 24;
      const bullet = this.game.bulletPool.acquire();
      bullet.reset(
        this.x + Math.cos(this.angle) * muzzleDistance,
        this.y + Math.sin(this.angle) * muzzleDistance,
        this.angle + randomRange(-0.018, 0.018),
        "player",
      );
      this.fireCooldown = 0.13;
      this.game.shake = Math.max(this.game.shake, 1.5);
      this.game.sound.shoot();
      for (let index = 0; index < 2; index += 1) {
        this.game.spawnParticle(
          this.x + Math.cos(this.angle) * muzzleDistance,
          this.y + Math.sin(this.angle) * muzzleDistance,
          COLORS.cyan,
          {
            vx: Math.cos(this.angle) * randomRange(55, 130) + randomRange(-35, 35),
            vy: Math.sin(this.angle) * randomRange(55, 130) + randomRange(-35, 35),
            size: randomRange(2, 4),
            life: 0.14,
          },
        );
      }
    }

    takeDamage(amount) {
      if (this.invulnerableTime > 0 || this.dashTime > 0 || !this.active) return;
      this.hp = Math.max(0, this.hp - amount);
      this.invulnerableTime = 0.55;
      this.hitFlash = 0.18;
      this.game.shake = Math.max(this.game.shake, 9);
      this.game.sound.playerHit();
      this.game.spawnBurst(this.x, this.y, COLORS.red, 14, 170);
      this.game.spawnFloatingText(this.x, this.y - 22, `-${amount}`, COLORS.red, 15);
      if (this.hp <= 0) {
        this.active = false;
        this.game.endGame();
      }
    }

    render(target) {
      target.save();
      target.translate(this.x, this.y);
      target.rotate(this.angle);

      if (this.invulnerableTime > 0 && Math.floor(this.invulnerableTime * 20) % 2 === 0) {
        target.globalAlpha = 0.45;
      }

      target.strokeStyle = this.hitFlash > 0 ? "#ffffff" : COLORS.cyan;
      target.fillStyle = "#102a3a";
      target.lineWidth = 2;
      target.shadowColor = COLORS.cyan;
      target.shadowBlur = this.dashTime > 0 ? 28 : 14;
      target.beginPath();
      target.moveTo(21, 0);
      target.lineTo(-12, -12);
      target.lineTo(-6, 0);
      target.lineTo(-12, 12);
      target.closePath();
      target.fill();
      target.stroke();

      target.fillStyle = "#d7fbff";
      target.beginPath();
      target.arc(2, 0, 3.5, 0, Math.PI * 2);
      target.fill();
      target.restore();

      if (this.dashCooldown > 0) {
        const progress = 1 - clamp(this.dashCooldown / 1.45, 0, 1);
        target.save();
        target.strokeStyle = "rgba(57, 231, 255, 0.45)";
        target.lineWidth = 2;
        target.beginPath();
        target.arc(this.x, this.y, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
        target.stroke();
        target.restore();
      }
    }
  }

  class Enemy {
    constructor(game) {
      this.game = game;
      this.active = false;
    }

    reset(type, x, y, wave) {
      const stats = ENEMY_STATS[type];
      this.type = type;
      this.x = x;
      this.y = y;
      this.radius = stats.radius;
      this.maxHp = stats.hp + Math.floor(wave * stats.hp * 0.08);
      this.hp = this.maxHp;
      this.speed = stats.speed + Math.min(wave * 2.2, 24);
      this.damage = stats.damage + Math.floor(wave * 0.6);
      this.score = stats.score;
      this.color = stats.color;
      this.fireCooldown = randomRange(0.5, 1.2);
      this.contactCooldown = 0;
      this.hitFlash = 0;
      this.age = randomRange(0, 10);
      this.active = true;
    }

    update(dt) {
      const player = this.game.player;
      if (!player.active) return;
      this.age += dt;
      this.fireCooldown -= dt;
      this.contactCooldown -= dt;
      this.hitFlash -= dt;

      const dx = player.x - this.x;
      const dy = player.y - this.y;
      const distance = Math.hypot(dx, dy) || 1;
      const directionX = dx / distance;
      const directionY = dy / distance;
      let moveX = directionX;
      let moveY = directionY;

      if (this.type === "shooter") {
        if (distance < 190) {
          moveX = -directionX;
          moveY = -directionY;
        } else if (distance < 310) {
          const strafe = Math.sin(this.age * 1.7) > 0 ? 1 : -1;
          moveX = -directionY * strafe * 0.72;
          moveY = directionX * strafe * 0.72;
        }
        if (this.fireCooldown <= 0 && distance < 540) this.shootAtPlayer(directionX, directionY);
      }

      const neighbours = this.game.enemyHash.query(this.x, this.y, this.radius + 34);
      this.game.stats.collisionCandidates += neighbours.length;
      for (const other of neighbours) {
        if (other === this || !other.active) continue;
        const separationX = this.x - other.x;
        const separationY = this.y - other.y;
        const separationDistance = Math.hypot(separationX, separationY) || 1;
        const preferred = this.radius + other.radius + 4;
        if (separationDistance < preferred) {
          const strength = (preferred - separationDistance) / preferred;
          moveX += (separationX / separationDistance) * strength * 0.7;
          moveY += (separationY / separationDistance) * strength * 0.7;
        }
      }

      const movementLength = Math.hypot(moveX, moveY) || 1;
      this.game.map.moveCircle(
        this,
        (moveX / movementLength) * this.speed * dt,
        (moveY / movementLength) * this.speed * dt,
      );

      if (distance <= this.radius + player.radius + 4 && this.contactCooldown <= 0) {
        player.takeDamage(this.damage);
        this.contactCooldown = 0.75;
      }
    }

    shootAtPlayer(directionX, directionY) {
      const bullet = this.game.bulletPool.acquire();
      const angle = Math.atan2(directionY, directionX) + randomRange(-0.05, 0.05);
      bullet.reset(
        this.x + directionX * (this.radius + 6),
        this.y + directionY * (this.radius + 6),
        angle,
        "enemy",
        { color: COLORS.violet, speed: 315, damage: this.damage, radius: 5, life: 2.2 },
      );
      this.fireCooldown = randomRange(1.25, 1.65);
      this.game.sound.enemyShoot();
    }

    takeDamage(amount) {
      if (!this.active) return;
      this.hp -= amount;
      this.hitFlash = 0.09;
      this.game.sound.hit();
      this.game.spawnFloatingText(this.x, this.y - this.radius - 5, Math.round(amount).toString(), COLORS.cyan, 12);
      if (this.hp <= 0) this.game.killEnemy(this);
    }

    render(target) {
      const pulse = 0.82 + Math.sin(this.age * 4) * 0.08;
      target.save();
      target.translate(this.x, this.y);
      target.rotate(this.age * (this.type === "drone" ? 1.8 : 0.25));
      target.strokeStyle = this.hitFlash > 0 ? "#ffffff" : this.color;
      target.fillStyle = this.type === "tank" ? "#2b211b" : "#171729";
      target.lineWidth = this.type === "tank" ? 3 : 2;
      target.shadowColor = this.color;
      target.shadowBlur = 10;

      if (this.type === "drone") {
        target.beginPath();
        target.moveTo(0, -this.radius * pulse);
        target.lineTo(this.radius * pulse, 0);
        target.lineTo(0, this.radius * pulse);
        target.lineTo(-this.radius * pulse, 0);
        target.closePath();
        target.fill();
        target.stroke();
      } else if (this.type === "shooter") {
        target.beginPath();
        for (let index = 0; index < 6; index += 1) {
          const angle = (Math.PI * 2 * index) / 6;
          const x = Math.cos(angle) * this.radius;
          const y = Math.sin(angle) * this.radius;
          if (index === 0) target.moveTo(x, y);
          else target.lineTo(x, y);
        }
        target.closePath();
        target.fill();
        target.stroke();
        target.fillStyle = this.color;
        target.fillRect(-4, -4, 8, 8);
      } else {
        target.fillRect(-this.radius, -this.radius, this.radius * 2, this.radius * 2);
        target.strokeRect(-this.radius, -this.radius, this.radius * 2, this.radius * 2);
        target.strokeRect(-this.radius + 7, -this.radius + 7, (this.radius - 7) * 2, (this.radius - 7) * 2);
      }
      target.restore();

      if (this.hp < this.maxHp) {
        const width = this.radius * 2.1;
        target.fillStyle = "rgba(0, 0, 0, 0.65)";
        target.fillRect(this.x - width / 2, this.y - this.radius - 11, width, 3);
        target.fillStyle = this.color;
        target.fillRect(this.x - width / 2, this.y - this.radius - 11, width * clamp(this.hp / this.maxHp, 0, 1), 3);
      }
    }
  }

  class WaveDirector {
    constructor(game) {
      this.game = game;
      this.reset();
    }

    reset() {
      this.wave = 1;
      this.countdown = 1.05;
      this.remaining = -1;
      this.spawnTimer = 0;
    }

    update(dt) {
      if (this.countdown > 0) {
        this.countdown -= dt;
        if (this.countdown <= 0) this.startWave();
        return;
      }

      if (this.remaining > 0) {
        this.spawnTimer -= dt;
        const maxAlive = Math.min(5 + this.wave, 14);
        if (this.spawnTimer <= 0 && this.game.enemyPool.countActive() < maxAlive) {
          this.spawnEnemy();
          this.remaining -= 1;
          this.spawnTimer = Math.max(0.2, 0.58 - this.wave * 0.025);
        }
      }

      if (this.remaining === 0 && this.game.enemyPool.countActive() === 0) {
        const bonus = this.wave * 250;
        this.game.score += bonus;
        this.game.player.hp = Math.min(this.game.player.maxHp, this.game.player.hp + 9);
        this.game.spawnFloatingText(
          this.game.player.x,
          this.game.player.y - 38,
          `WAVE CLEAR +${bonus}`,
          COLORS.green,
          15,
        );
        this.wave += 1;
        this.countdown = 2.35;
        this.remaining = -1;
        this.game.showToast(`波次 ${String(this.wave - 1).padStart(2, "0")} 已清除，生命恢复 9`);
      }
    }

    startWave() {
      this.remaining = 3 + this.wave * 2;
      this.spawnTimer = 0;
      this.game.sound.wave();
      this.game.showToast(`WAVE ${String(this.wave).padStart(2, "0")} / 敌人信号已接入`);
    }

    chooseType() {
      const roll = Math.random();
      if (this.wave >= 4 && roll < Math.min(0.08 + this.wave * 0.018, 0.28)) return "tank";
      if (this.wave >= 2 && roll < Math.min(0.28 + this.wave * 0.025, 0.55)) return "shooter";
      return "drone";
    }

    spawnEnemy() {
      const spawns = this.game.map.enemySpawns;
      let chosen = spawns[Math.floor(Math.random() * spawns.length)];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = spawns[Math.floor(Math.random() * spawns.length)];
        const position = this.game.map.getWorldPosition(candidate);
        if (distanceSquared(position, this.game.player) > 280 * 280) {
          chosen = candidate;
          break;
        }
      }
      const position = this.game.map.getWorldPosition(chosen);
      const enemy = this.game.enemyPool.acquire();
      enemy.reset(this.chooseType(), position.x, position.y, this.wave);
      this.game.spawnBurst(position.x, position.y, enemy.color, 9, 115);
    }
  }

  class Game {
    constructor() {
      this.input = new InputManager(canvas);
      this.sound = new SoundManager();
      this.map = new MapManager();
      this.enemyHash = new SpatialHash(84);
      this.player = new Player(this);
      this.bulletPool = new ObjectPool(() => new Bullet(this), 36);
      this.enemyPool = new ObjectPool(() => new Enemy(this), 14);
      this.particlePool = new ObjectPool(() => new Particle(), 100);
      this.textPool = new ObjectPool(() => new FloatingText(), 18);
      this.waveDirector = new WaveDirector(this);
      this.state = "menu";
      this.editorTool = "wall";
      this.lastEditorCell = "";
      this.score = 0;
      this.combo = 0;
      this.comboTimer = 0;
      this.highScore = Number(safeStorageGet(CONFIG.scoreKey, "0")) || 0;
      this.shake = 0;
      this.showDebug = false;
      this.stats = {
        fps: 60,
        frameCount: 0,
        fpsTimer: 0,
        collisionCandidates: 0,
      };
      this.lastTime = performance.now();
      this.accumulator = 0;
      this.hudTimer = 0;
      this.toastTimeout = 0;
      this.bindUI();
      this.refreshMapData();
      this.rebuildEnemyHash();
      requestAnimationFrame((time) => this.loop(time));
    }

    bindUI() {
      $("#startButton").addEventListener("click", () => this.startGame());
      $("#restartButton").addEventListener("click", () => this.startGame());
      $("#pauseButton").addEventListener("click", () => this.togglePause());
      $("#continueButton").addEventListener("click", () => this.togglePause());
      $("#exitButton").addEventListener("click", () => this.exitToMenu());
      $("#soundButton").addEventListener("click", (event) => {
        const enabled = this.sound.toggle();
        event.currentTarget.classList.toggle("is-active", !enabled);
        event.currentTarget.textContent = enabled ? "SFX" : "OFF";
        this.showToast(enabled ? "音效已开启" : "音效已关闭");
      });
      $("#fullscreenButton").addEventListener("click", () => {
        const frame = $("#arenaWrap");
        if (!document.fullscreenElement) frame.requestFullscreen?.();
        else document.exitFullscreen?.();
      });

      for (const button of $$(".mode-button")) {
        button.addEventListener("click", () => this.setMode(button.dataset.mode));
      }

      for (const button of $$(".tool-button")) {
        button.addEventListener("click", () => {
          this.editorTool = button.dataset.tool;
          $$(".tool-button").forEach((item) => item.classList.toggle("is-active", item === button));
        });
      }

      $("#exportButton").addEventListener("click", async () => {
        this.refreshMapData();
        const textarea = $("#mapData");
        try {
          await navigator.clipboard.writeText(textarea.value);
          this.showToast("关卡 JSON 已复制到剪贴板");
        } catch (_error) {
          textarea.focus();
          textarea.select();
          this.showToast("关卡 JSON 已生成，请手动复制");
        }
      });

      $("#importButton").addEventListener("click", () => {
        try {
          const data = JSON.parse($("#mapData").value);
          if (!this.map.applyData(data)) throw new Error("关卡尺寸或字段不正确");
          this.refreshMapData();
          this.showToast("关卡数据载入成功");
        } catch (error) {
          this.showToast(`载入失败：${error.message}`);
        }
      });

      $("#resetMapButton").addEventListener("click", () => {
        this.map.reset();
        this.refreshMapData();
        this.showToast("关卡已恢复为默认布局");
      });

      $("#testMapButton").addEventListener("click", () => {
        this.setMode("play");
        this.startGame();
      });
    }

    setMode(mode) {
      const editor = mode === "editor";
      $$(".mode-button").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.mode === mode);
      });
      $("#editorPanel").classList.toggle("is-hidden", !editor);
      $("#editorBadge").classList.toggle("is-hidden", !editor);
      $("#startScreen").classList.toggle("is-hidden", editor);
      $("#gameOverScreen").classList.add("is-hidden");
      this.setPauseMenuVisible(false);

      this.clearRuntimeObjects();
      if (editor) {
        this.state = "editor";
        this.refreshMapData();
        this.showToast("关卡编辑模式：选择工具后点击网格");
      } else {
        this.state = "menu";
        this.lastEditorCell = "";
      }
    }

    startGame() {
      this.clearRuntimeObjects();
      const spawn = this.map.getWorldPosition(this.map.playerSpawn);
      this.player.reset(spawn);
      this.waveDirector.reset();
      this.score = 0;
      this.combo = 0;
      this.comboTimer = 0;
      this.shake = 0;
      this.state = "playing";
      $("#startScreen").classList.add("is-hidden");
      $("#gameOverScreen").classList.add("is-hidden");
      this.setPauseMenuVisible(false);
      canvas.focus();
      this.sound.ensureContext();
      this.showToast("连接成功 / 作战开始");
    }

    clearRuntimeObjects() {
      this.bulletPool.clear();
      this.enemyPool.clear();
      this.particlePool.clear();
      this.textPool.clear();
      this.player.active = false;
      this.rebuildEnemyHash();
    }

    togglePause() {
      if (this.state === "playing") {
        this.state = "paused";
        this.setPauseMenuVisible(true);
        $("#continueButton").focus();
      } else if (this.state === "paused") {
        this.state = "playing";
        this.setPauseMenuVisible(false);
        canvas.focus();
        this.showToast("作战继续");
      }
    }

    setPauseMenuVisible(visible) {
      $("#pauseScreen").classList.toggle("is-hidden", !visible);
      $("#pauseButton").classList.toggle("is-active", visible);
    }

    exitToMenu() {
      if (this.state !== "paused") return;
      this.clearRuntimeObjects();
      this.waveDirector.reset();
      this.score = 0;
      this.combo = 0;
      this.comboTimer = 0;
      this.state = "menu";
      this.setPauseMenuVisible(false);
      $("#gameOverScreen").classList.add("is-hidden");
      $("#startScreen").classList.remove("is-hidden");
      $("#startButton").focus();
      this.updateHud();
      this.showToast("已退出当前作战");
    }

    endGame() {
      this.state = "gameover";
      this.setPauseMenuVisible(false);
      this.spawnBurst(this.player.x, this.player.y, COLORS.cyan, 28, 240);
      this.highScore = Math.max(this.highScore, Math.floor(this.score));
      safeStorageSet(CONFIG.scoreKey, String(this.highScore));
      $("#finalScore").textContent = padScore(this.score);
      $("#finalWave").textContent = String(this.waveDirector.wave).padStart(2, "0");
      $("#bestScore").textContent = padScore(this.highScore);
      window.setTimeout(() => $("#gameOverScreen").classList.remove("is-hidden"), 420);
    }

    killEnemy(enemy) {
      enemy.active = false;
      this.combo += 1;
      this.comboTimer = 2.8;
      const multiplier = this.getComboMultiplier();
      const gained = Math.floor(enemy.score * multiplier);
      this.score += gained;
      this.shake = Math.max(this.shake, enemy.type === "tank" ? 8 : 4);
      this.sound.destroy();
      this.spawnBurst(enemy.x, enemy.y, enemy.color, enemy.type === "tank" ? 24 : 13, 190);
      this.spawnFloatingText(enemy.x, enemy.y - 18, `+${gained}`, enemy.color, 14);
    }

    getComboMultiplier() {
      return 1 + Math.min(Math.floor(this.combo / 5) * 0.25, 2);
    }

    spawnParticle(x, y, color, options) {
      const particle = this.particlePool.acquire();
      particle.reset(x, y, color, options);
    }

    spawnBurst(x, y, color, count, speed) {
      for (let index = 0; index < count; index += 1) {
        const angle = randomRange(0, Math.PI * 2);
        const velocity = randomRange(speed * 0.35, speed);
        this.spawnParticle(x, y, color, {
          vx: Math.cos(angle) * velocity,
          vy: Math.sin(angle) * velocity,
          size: randomRange(1.5, 5),
          life: randomRange(0.2, 0.58),
          drag: 0.9,
        });
      }
    }

    spawnFloatingText(x, y, text, color, size) {
      const floatingText = this.textPool.acquire();
      floatingText.reset(x, y, text, color, size);
    }

    showToast(message) {
      const toast = $("#toast");
      toast.textContent = message;
      toast.classList.remove("is-hidden");
      window.clearTimeout(this.toastTimeout);
      this.toastTimeout = window.setTimeout(() => toast.classList.add("is-hidden"), 1900);
    }

    refreshMapData() {
      $("#mapData").value = JSON.stringify(this.map.serialize());
      const state = $("#saveState");
      state.textContent = "已保存";
      state.style.color = COLORS.green;
    }

    loop(time) {
      const delta = Math.min((time - this.lastTime) / 1000, 0.1);
      this.lastTime = time;
      this.accumulator += delta;
      this.trackFps(delta);
      this.handleGlobalInput();

      while (this.accumulator >= CONFIG.fixedStep) {
        this.update(CONFIG.fixedStep);
        this.accumulator -= CONFIG.fixedStep;
      }

      this.render();
      requestAnimationFrame((nextTime) => this.loop(nextTime));
    }

    trackFps(delta) {
      this.stats.frameCount += 1;
      this.stats.fpsTimer += delta;
      if (this.stats.fpsTimer >= 0.5) {
        this.stats.fps = Math.round(this.stats.frameCount / this.stats.fpsTimer);
        this.stats.frameCount = 0;
        this.stats.fpsTimer = 0;
      }
    }

    handleGlobalInput() {
      if (this.input.consume("F3")) this.showDebug = !this.showDebug;
      if (this.input.consume("Escape")) this.togglePause();
      if (this.state === "menu" && this.input.consume("Enter")) this.startGame();
      if (this.state === "gameover" && this.input.consume("KeyR")) this.startGame();
    }

    update(dt) {
      this.stats.collisionCandidates = 0;
      this.shake = Math.max(0, this.shake - 24 * dt);
      this.hudTimer -= dt;

      if (this.state === "editor") {
        this.updateEditor();
        this.updateHud();
        return;
      }

      if (this.state !== "playing") {
        this.updateParticles(dt);
        this.updateHud();
        return;
      }

      this.player.update(dt);

      this.rebuildEnemyHash();
      for (const enemy of this.enemyPool.items) if (enemy.active) enemy.update(dt);
      this.rebuildEnemyHash();

      for (const bullet of this.bulletPool.items) if (bullet.active) bullet.update(dt);
      this.updateParticles(dt);
      this.waveDirector.update(dt);

      if (this.comboTimer > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) this.combo = 0;
      }

      this.updateHud();
    }

    updateEditor() {
      const mouse = this.input.mouse;
      const clicked = this.input.consumeClick();
      const rightClicked = this.input.consumeRightClick();
      if (!mouse.down && !clicked && !rightClicked) {
        this.lastEditorCell = "";
        return;
      }
      const col = Math.floor(mouse.x / CONFIG.tile);
      const row = Math.floor(mouse.y / CONFIG.tile);
      const activeTool = rightClicked ? "erase" : this.editorTool;
      const cellKey = `${col},${row},${activeTool}`;
      if (cellKey === this.lastEditorCell) return;
      this.lastEditorCell = cellKey;
      const isPlayerSpawn =
        this.map.playerSpawn.col === col && this.map.playerSpawn.row === row;
      if (activeTool === "erase" && isPlayerSpawn) {
        this.showToast("玩家出生点必须保留，请先在其他位置放置新的出生点");
        return;
      }
      if (this.map.editCell(col, row, activeTool)) {
        this.refreshMapData();
        const saveState = $("#saveState");
        saveState.textContent = activeTool === "erase" ? "删除并保存" : "自动保存";
      }
    }

    updateParticles(dt) {
      for (const particle of this.particlePool.items) if (particle.active) particle.update(dt);
      for (const text of this.textPool.items) if (text.active) text.update(dt);
    }

    rebuildEnemyHash() {
      this.enemyHash.clear();
      for (const enemy of this.enemyPool.items) if (enemy.active) this.enemyHash.insert(enemy);
    }

    updateHud() {
      if (this.hudTimer > 0) return;
      this.hudTimer = 0.1;
      const activeEnemies = this.enemyPool.countActive();
      const enemyCount = activeEnemies + Math.max(0, this.waveDirector.remaining);
      const totalObjects = activeEnemies + this.bulletPool.countActive() + this.particlePool.countActive();
      const poolTotal = this.bulletPool.created + this.enemyPool.created + this.particlePool.created;
      const poolReused = this.bulletPool.reused + this.enemyPool.reused + this.particlePool.reused;
      const poolRatio = poolTotal + poolReused ? poolReused / (poolTotal + poolReused) : 0;

      $("#fpsValue").textContent = String(this.stats.fps);
      $("#entityValue").textContent = String(totalObjects);
      $("#collisionValue").textContent = String(this.stats.collisionCandidates);
      $("#poolValue").textContent = `${Math.round(poolRatio * 100)}%`;
      $("#waveLabel").textContent = `WAVE ${String(this.waveDirector.wave).padStart(2, "0")}`;
      $("#waveValue").textContent = `第 ${this.waveDirector.wave} 波`;
      $("#enemyCount").textContent = String(enemyCount);
      $("#comboValue").textContent = `×${this.getComboMultiplier().toFixed(2)}`;
      $("#scoreValue").textContent = padScore(this.score);
    }

    render() {
      ctx.save();
      if (this.shake > 0 && this.state === "playing") {
        ctx.translate(randomRange(-this.shake, this.shake), randomRange(-this.shake, this.shake));
      }
      this.map.render(ctx);

      if (this.state === "editor") {
        this.map.renderEditorMarkers(ctx);
        this.renderEditorCursor(ctx);
      } else {
        for (const particle of this.particlePool.items) if (particle.active) particle.render(ctx);
        for (const bullet of this.bulletPool.items) if (bullet.active) bullet.render(ctx);
        for (const enemy of this.enemyPool.items) if (enemy.active) enemy.render(ctx);
        if (this.player.active) this.player.render(ctx);
        for (const text of this.textPool.items) if (text.active) text.render(ctx);
        if (["playing", "paused", "gameover"].includes(this.state)) this.renderHud(ctx);
        if (this.state === "playing") this.renderCrosshair(ctx);
      }

      if (this.showDebug) this.renderDebug(ctx);
      ctx.restore();
    }

    renderHud(target) {
      const healthRatio = this.player.maxHp ? clamp(this.player.hp / this.player.maxHp, 0, 1) : 0;
      const remainingEnemies =
        this.enemyPool.countActive() + Math.max(0, this.waveDirector.remaining);
      target.save();
      target.fillStyle = "rgba(5, 10, 18, 0.78)";
      target.fillRect(24, 22, 300, 64);
      target.strokeStyle = "rgba(120, 155, 210, 0.2)";
      target.strokeRect(24.5, 22.5, 300, 64);
      target.fillStyle = COLORS.text;
      target.font = "700 12px Consolas, monospace";
      target.fillText("HP / SYNTHETIC FRAME", 40, 44);
      target.fillStyle = "rgba(255,255,255,0.08)";
      target.fillRect(40, 56, 222, 9);
      const healthColor = healthRatio > 0.35 ? COLORS.cyan : COLORS.red;
      target.fillStyle = healthColor;
      target.shadowColor = healthColor;
      target.shadowBlur = 10;
      target.fillRect(40, 56, 222 * healthRatio, 9);
      target.shadowBlur = 0;
      target.fillStyle = COLORS.text;
      target.font = "700 14px Consolas, monospace";
      target.textAlign = "right";
      target.fillText(`${Math.ceil(this.player.hp)}`, 305, 65);

      target.textAlign = "right";
      target.fillStyle = "rgba(5, 10, 18, 0.72)";
      target.fillRect(CONFIG.width - 270, 22, 246, 64);
      target.strokeStyle = "rgba(120, 155, 210, 0.2)";
      target.strokeRect(CONFIG.width - 269.5, 22.5, 245, 63);
      target.fillStyle = COLORS.muted;
      target.font = "10px Consolas, monospace";
      target.fillText("COMBAT SCORE", CONFIG.width - 40, 43);
      target.fillStyle = COLORS.text;
      target.font = "700 25px Consolas, monospace";
      target.fillText(padScore(this.score), CONFIG.width - 40, 69);

      const wavePanelWidth = 250;
      const wavePanelX = CONFIG.width / 2 - wavePanelWidth / 2;
      target.textAlign = "left";
      target.fillStyle = "rgba(5, 10, 18, 0.82)";
      target.fillRect(wavePanelX, 22, wavePanelWidth, 64);
      target.strokeStyle = "rgba(165, 108, 255, 0.35)";
      target.strokeRect(wavePanelX + 0.5, 22.5, wavePanelWidth - 1, 63);
      target.fillStyle = COLORS.violet;
      target.font = "700 9px Consolas, monospace";
      target.fillText("CURRENT WAVE", wavePanelX + 16, 42);
      target.fillStyle = COLORS.text;
      target.font = "700 23px Consolas, monospace";
      target.fillText(`WAVE ${String(this.waveDirector.wave).padStart(2, "0")}`, wavePanelX + 16, 69);
      target.textAlign = "right";
      target.fillStyle = COLORS.muted;
      target.font = "9px Consolas, monospace";
      target.fillText("REMAINING", wavePanelX + wavePanelWidth - 16, 43);
      target.fillStyle = COLORS.cyan;
      target.font = "700 19px Consolas, monospace";
      target.fillText(String(remainingEnemies), wavePanelX + wavePanelWidth - 16, 68);

      if (this.combo > 1 && this.comboTimer > 0) {
        target.textAlign = "center";
        target.fillStyle = COLORS.violet;
        target.font = "700 20px Consolas, monospace";
        target.shadowColor = COLORS.violet;
        target.shadowBlur = 13;
        target.fillText(`${this.combo} HIT  ×${this.getComboMultiplier().toFixed(2)}`, CONFIG.width / 2, 113);
      }

      if (this.waveDirector.countdown > 0 && this.waveDirector.countdown < 1.9 && this.state === "playing") {
        target.textAlign = "center";
        target.fillStyle = "rgba(57, 231, 255, 0.88)";
        target.font = "700 13px Consolas, monospace";
        target.fillText(`INCOMING / WAVE ${String(this.waveDirector.wave).padStart(2, "0")}`, CONFIG.width / 2, 137);
      }
      target.restore();
    }

    renderCrosshair(target) {
      const { x, y } = this.input.mouse;
      target.save();
      target.translate(x, y);
      target.strokeStyle = "rgba(57, 231, 255, 0.85)";
      target.fillStyle = COLORS.cyan;
      target.lineWidth = 1;
      target.shadowColor = COLORS.cyan;
      target.shadowBlur = 8;
      target.beginPath();
      target.arc(0, 0, 8, 0, Math.PI * 2);
      target.stroke();
      target.beginPath();
      target.moveTo(-14, 0); target.lineTo(-6, 0);
      target.moveTo(14, 0); target.lineTo(6, 0);
      target.moveTo(0, -14); target.lineTo(0, -6);
      target.moveTo(0, 14); target.lineTo(0, 6);
      target.stroke();
      target.fillRect(-1, -1, 2, 2);
      target.restore();
    }

    renderEditorCursor(target) {
      const col = Math.floor(this.input.mouse.x / CONFIG.tile);
      const row = Math.floor(this.input.mouse.y / CONFIG.tile);
      if (col < 0 || row < 0 || col >= CONFIG.cols || row >= CONFIG.rows) return;
      const toolColors = {
        wall: COLORS.blue,
        erase: COLORS.muted,
        enemy: COLORS.red,
        player: COLORS.cyan,
      };
      target.save();
      target.fillStyle = `${toolColors[this.editorTool]}22`;
      target.strokeStyle = toolColors[this.editorTool];
      target.lineWidth = 2;
      target.fillRect(col * CONFIG.tile + 2, row * CONFIG.tile + 2, CONFIG.tile - 4, CONFIG.tile - 4);
      target.strokeRect(col * CONFIG.tile + 2, row * CONFIG.tile + 2, CONFIG.tile - 4, CONFIG.tile - 4);
      target.restore();
    }

    renderDebug(target) {
      const activeBullets = this.bulletPool.countActive();
      const activeEnemies = this.enemyPool.countActive();
      const activeParticles = this.particlePool.countActive();
      target.save();
      target.fillStyle = "rgba(3, 8, 14, 0.9)";
      target.fillRect(24, CONFIG.height - 152, 286, 126);
      target.strokeStyle = "rgba(57, 231, 255, 0.38)";
      target.strokeRect(24.5, CONFIG.height - 151.5, 285, 125);
      target.fillStyle = COLORS.cyan;
      target.font = "700 11px Consolas, monospace";
      target.fillText("RUNTIME PROFILER / F3", 39, CONFIG.height - 128);
      target.fillStyle = "#91a2ba";
      target.font = "10px Consolas, monospace";
      const lines = [
        `FPS                 ${this.stats.fps}`,
        `ENEMIES             ${activeEnemies}/${this.enemyPool.items.length}`,
        `BULLETS             ${activeBullets}/${this.bulletPool.items.length}`,
        `PARTICLES           ${activeParticles}/${this.particlePool.items.length}`,
        `COLLISION CANDIDATES ${this.stats.collisionCandidates}`,
      ];
      lines.forEach((line, index) => target.fillText(line, 39, CONFIG.height - 105 + index * 17));
      target.restore();
    }

  }

  new Game();
})();
