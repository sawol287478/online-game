/* =========================================================================
   브레이크라인 (Breakline) - 실시간 1:1 스와이프 벽돌깨기 대결
   - 순수 프론트엔드 + WebRTC(PeerJS) 로만 동작 (별도 서버 불필요)
   - 두 플레이어는 동일한 시드로 완전히 같은 벽돌 패턴을 받아 공정하게 대결
   ========================================================================= */

(() => {
  "use strict";

  /* ---------------------------------------------------------------------
     0. 기본 설정
  --------------------------------------------------------------------- */
  const COLS = 7;
  const ROWS = 9;                // 보드에 보이는 줄 수 (마지막 줄 = 패배 판정 줄)
  const MATCH_SECONDS = 90;
  const BALL_RADIUS_RATIO = 0.016;   // 보드 너비 대비 공 반지름 비율
  const BALL_SPEED_RATIO = 0.62;     // 보드 너비 대비 초당 이동 비율
  const LAUNCH_GAP_MS = 60;          // 공 발사 간격
  const HEARTBEAT_MS = 400;

  const BRICK_COLORS = ["#4ce0d2", "#6fd1ff", "#a78bfa", "#ffc857", "#ff9f6b", "#ff7a59"];
  const PICKUP_COLOR = "#8dff9e";

  /* ---------------------------------------------------------------------
     1. 시드 기반 난수 (두 플레이어가 동일한 벽돌 패턴을 받기 위함)
  --------------------------------------------------------------------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  /* ---------------------------------------------------------------------
     2. 벽돌 줄 생성
  --------------------------------------------------------------------- */
  function generateRow(rng, round) {
    // 처음 5줄(round 0~4)은 무조건 체력 1 -> 한 번만 맞아도 깨지는 쉬운 시작
    // 이후부터 서서히 체력/밀도가 올라가는 완만한 난이도 곡선
    const EASY_ROUNDS = 5;
    const minHP = round < EASY_ROUNDS ? 1 : 1 + Math.floor((round - EASY_ROUNDS) / 6);
    const maxHP = round < EASY_ROUNDS ? 1 : Math.min(2 + Math.floor((round - EASY_ROUNDS) / 3), 30);
    const density = Math.min(0.35 + round * 0.008, 0.78);
    const row = new Array(COLS).fill(0);
    for (let c = 0; c < COLS; c++) {
      if (rng() < density) {
        row[c] = minHP + Math.floor(rng() * (maxHP - minHP + 1));
      }
    }
    // 최소 한 칸은 벽돌이 있도록 보정
    if (row.every(v => v === 0)) {
      row[Math.floor(rng() * COLS)] = minHP;
    }
    // 가끔 픽업(+1 공) 배치 (초반에 조금 더 자주 나와서 공 개수를 빨리 늘려줌)
    const pickupChance = round < 8 ? 0.16 : 0.11;
    if (rng() < pickupChance) {
      const candidates = row.map((v, i) => i).filter(i => row[i] > 0);
      if (candidates.length) {
        const idx = candidates[Math.floor(rng() * candidates.length)];
        row[idx] = -1; // -1 = 픽업 전용 칸 (체력 1, 파괴시 공 +1)
      }
    }
    return row;
  }

  /* ---------------------------------------------------------------------
     3. 플레이어 보드 상태 (나 / 상대 공용 클래스, 상대는 물리 시뮬 없이
        네트워크로 받은 스냅샷만 그려줌)
  --------------------------------------------------------------------- */
  class Board {
    constructor(canvas, isLocal) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.isLocal = isLocal;
      this.reset();
    }

    reset() {
      this.grid = [];              // ROWS x COLS, 0=없음 -1=픽업 n=체력
      this.round = 0;
      this.score = 0;
      this.ballCount = 3;
      this.alive = true;
      this.balls = [];             // 활성 공 {x,y,vx,vy}
      this.launcherX = 0.5;        // 0~1 비율
      this.pendingLaunch = null;   // {dx,dy,count,launched,timer}
      this.shotInProgress = false;
      this.aiming = false;
      this.aimVec = null;
      this.flashRow = -1;
      this.flashTimer = 0;
    }

    fillInitialRows(rng) {
      this.grid = [];
      const INITIAL_FILLED_ROWS = 3; // 시작 시 벽돌이 있는 줄 수 (맨 위쪽)
      for (let r = 0; r < ROWS; r++) {
        // 벽돌은 맨 위(안전한 곳)부터 채우고, 패배 라인에 가까운 아래쪽은
        // 비워둬서 초반에 대응할 시간(버퍼)을 충분히 확보
        if (r < INITIAL_FILLED_ROWS) this.grid.push(generateRow(rng, this.round++));
        else this.grid.push(new Array(COLS).fill(0));
      }
    }
  }

  /* ---------------------------------------------------------------------
     4. 메인 게임 컨트롤러
  --------------------------------------------------------------------- */
  const el = (id) => document.getElementById(id);

  const screens = {
    lobby: el("screen-lobby"),
    wait: el("screen-wait"),
    game: el("screen-game"),
    result: el("screen-result"),
  };
  function showScreen(name) {
    Object.values(screens).forEach(s => s.hidden = true);
    screens[name].hidden = false;
  }

  function toast(msg, ms = 2600) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  const state = {
    role: null,           // 'host' | 'guest'
    peer: null,
    conn: null,
    roomCode: null,
    myName: "나",
    oppName: "상대",
    seed: null,
    startAt: null,
    rng: null,
    me: null,             // Board
    opp: null,            // Board (원격 스냅샷 표시용)
    running: false,
    rafId: null,
    lastTs: 0,
    lastHeartbeat: 0,
    finished: false,
    myFinal: null,
    oppFinal: null,
    rematchWanted: false,
    oppRematchWanted: false,
  };

  /* ---------------------------------------------------------------------
     5. PeerJS 연결
  --------------------------------------------------------------------- */
  function ensurePeer(id) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(id, { debug: 1 });
      peer.on("open", () => resolve(peer));
      peer.on("error", (err) => reject(err));
    });
  }

  function wireConnection(conn, isHost) {
    state.conn = conn;
    let openHandled = false;
    const onOpen = () => {
      if (openHandled) return; // 이벤트가 중복으로 들어와도 한 번만 처리
      openHandled = true;
      if (isHost) {
        const seed = Math.floor(Math.random() * 2 ** 31);
        const startAt = Date.now() + 3200;
        state.seed = seed;
        state.startAt = startAt;
        conn.send({ t: "hello", name: state.myName });
        conn.send({ t: "start", seed, startAt, hostName: state.myName });
        beginMatchFlow();
      } else {
        conn.send({ t: "hello", name: state.myName });
      }
    };
    conn.on("open", onOpen);
    // PeerJS는 리스너를 붙이기 전에 연결이 이미 열려버리는 경우가 있어
    // 'open' 이벤트를 놓칠 수 있음 -> 이미 열려있다면 즉시 수동으로 처리
    if (conn.open) onOpen();
    else setTimeout(() => { if (conn.open) onOpen(); }, 300);
    conn.on("data", handleData);
    conn.on("close", () => {
      if (state.running) {
        toast("상대방과의 연결이 끊어졌어요.");
        endMatchByDisconnect();
      }
    });
    conn.on("error", () => {
      toast("연결 중 오류가 발생했어요.");
    });
  }

  function handleData(msg) {
    switch (msg.t) {
      case "hello":
        state.oppName = msg.name || "상대";
        el("hud-name-opp").textContent = state.oppName.toUpperCase();
        el("opp-compact-name").textContent = state.oppName;
        el("result-name-opp").textContent = state.oppName;
        break;
      case "start":
        state.seed = msg.seed;
        state.startAt = msg.startAt;
        if (msg.hostName) {
          state.oppName = msg.hostName;
          el("hud-name-opp").textContent = state.oppName.toUpperCase();
          el("opp-compact-name").textContent = state.oppName;
          el("result-name-opp").textContent = state.oppName;
        }
        beginMatchFlow();
        break;
      case "update":
        applyOpponentUpdate(msg);
        break;
      case "hb":
        state.opp.score = msg.score;
        state.opp.ballCount = msg.ballCount;
        state.opp.alive = msg.alive;
        updateHud();
        updateCompactOpp();
        break;
      case "final":
        state.oppFinal = { score: msg.score, alive: msg.alive };
        maybeShowResult();
        break;
      case "rematch":
        state.oppRematchWanted = true;
        el("rematch-status").textContent = state.rematchWanted
          ? "곧 새 대결이 시작돼요..."
          : `${state.oppName}님이 재대결을 원해요`;
        maybeRematch();
        break;
      default:
        break;
    }
  }

  function applyOpponentUpdate(msg) {
    state.opp.grid = msg.grid;
    state.opp.round = msg.round;
    state.opp.score = msg.score;
    state.opp.ballCount = msg.ballCount;
    state.opp.alive = msg.alive;
    if (!msg.alive) showBoardStatus("opp", "GAME OVER");
    updateHud();
    updateCompactOpp();
  }

  /* ---------------------------------------------------------------------
     6. 로비 UI 로직
  --------------------------------------------------------------------- */
  el("btn-create").addEventListener("click", async () => {
    const name = el("input-nick-host").value.trim();
    state.myName = name || "나";
    el("btn-create").disabled = true;
    el("btn-create").textContent = "방 생성 중...";
    try {
      const code = makeRoomCode();
      const peer = await ensurePeer("bkln-" + code);
      state.peer = peer;
      state.role = "host";
      state.roomCode = code;
      el("wait-room-code").textContent = code;
      showScreen("wait");
      peer.on("connection", (conn) => {
        wireConnection(conn, true);
      });
      peer.on("disconnected", () => {});
    } catch (err) {
      console.error(err);
      toast("방을 만들지 못했어요. 네트워크 상태를 확인해주세요.");
      el("btn-create").disabled = false;
      el("btn-create").textContent = "대결방 만들기";
    }
  });

  el("btn-join").addEventListener("click", async () => {
    const name = el("input-nick-join").value.trim();
    const code = el("input-join-code").value.trim().toUpperCase();
    if (!code) { toast("상대방 방 코드를 입력해주세요."); return; }
    state.myName = name || "나";
    el("btn-join").disabled = true;
    el("btn-join").textContent = "접속 중...";
    try {
      const peer = await ensurePeer(null);
      state.peer = peer;
      state.role = "guest";
      const conn = peer.connect("bkln-" + code, { reliable: true });
      let opened = false;
      conn.on("open", () => { opened = true; });
      wireConnection(conn, false);
      setTimeout(() => {
        if (!opened) {
          toast("방을 찾을 수 없어요. 코드를 다시 확인해주세요.");
          el("btn-join").disabled = false;
          el("btn-join").textContent = "참가하기";
        }
      }, 7000);
    } catch (err) {
      console.error(err);
      toast("접속하지 못했어요. 네트워크 상태를 확인해주세요.");
      el("btn-join").disabled = false;
      el("btn-join").textContent = "참가하기";
    }
  });

  el("btn-copy-code").addEventListener("click", () => {
    const code = state.roomCode;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(() => toast("코드를 복사했어요."));
    } else {
      toast("코드: " + code);
    }
  });

  el("btn-cancel-wait").addEventListener("click", () => {
    location.reload();
  });

  el("btn-exit").addEventListener("click", () => {
    location.reload();
  });

  /* ---------------------------------------------------------------------
     7. 매치 시작 흐름 (양쪽 모두 seed/startAt 확보 후 호출)
  --------------------------------------------------------------------- */
  function beginMatchFlow() {
    el("hud-name-me").textContent = state.myName.toUpperCase();
    el("hud-name-opp").textContent = state.oppName.toUpperCase();
    el("opp-compact-name").textContent = state.oppName;
    el("result-name-me").textContent = state.myName;
    el("result-name-opp").textContent = state.oppName;

    const canvasMe = el("canvas-me");
    const canvasOpp = el("canvas-opp");
    state.me = new Board(canvasMe, true);
    state.opp = new Board(canvasOpp, false);

    state.rng = mulberry32(state.seed);
    state.me.fillInitialRows(state.rng);
    // 상대 보드도 동일 규칙으로 초기화된 상태를 화면상 기본값으로 표시
    const rngCopy = mulberry32(state.seed);
    state.opp.fillInitialRows(rngCopy);

    state.finished = false;
    state.myFinal = null;
    state.oppFinal = null;
    state.rematchWanted = false;
    state.oppRematchWanted = false;
    el("status-me").hidden = true;
    el("status-opp").hidden = true;
    el("status-me").textContent = "";
    el("status-opp").textContent = "";

    showScreen("game");
    resizeCanvases();
    updateHud();
    updateCompactOpp();

    const wait = Math.max(0, state.startAt - Date.now());
    setTimeout(runCountdown, wait);
  }

  function runCountdown() {
    const overlay = el("countdown-overlay");
    const num = el("countdown-num");
    overlay.hidden = false;
    let n = 3;
    num.textContent = n;
    num.style.animation = "none"; void num.offsetWidth; num.style.animation = "";
    const iv = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(iv);
        overlay.hidden = true;
        startMatch();
      } else {
        num.textContent = n;
        num.style.animation = "none"; void num.offsetWidth; num.style.animation = "";
      }
    }, 700);
  }

  function startMatch() {
    state.running = true;
    state.matchEndsAt = Date.now() + MATCH_SECONDS * 1000;
    state.lastTs = performance.now();
    bindInput();
    state.rafId = requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------------
     8. 물리 / 게임 루프
  --------------------------------------------------------------------- */
  function boardPixel(board) {
    return board.canvas.width; // 정사각 좌표계 아님: width=height 아니어도 OK, 폭 기준 스케일
  }

  function loop(ts) {
    if (!state.running) return;
    const dt = Math.min(32, ts - state.lastTs);
    state.lastTs = ts;

    stepBoard(state.me, dt);
    render(state.me);
    render(state.opp, true);

    // 타이머
    const remainMs = Math.max(0, state.matchEndsAt - Date.now());
    updateTimerUI(remainMs);
    if (remainMs <= 0 && !state.finished) {
      finishLocal(state.me.alive);
    }

    // heartbeat
    if (ts - state.lastHeartbeat > HEARTBEAT_MS) {
      state.lastHeartbeat = ts;
      sendSafe({ t: "hb", score: state.me.score, ballCount: state.me.ballCount, alive: state.me.alive });
    }

    if (state.running) state.rafId = requestAnimationFrame(loop);
  }

  function stepBoard(board, dt) {
    if (!board.alive) return;
    const w = board.canvas.width, h = board.canvas.height;
    const R = w * BALL_RADIUS_RATIO;
    const speed = w * BALL_SPEED_RATIO / 1000; // px/ms

    // 발사 대기열 처리
    if (board.pendingLaunch) {
      const p = board.pendingLaunch;
      p.timer += dt;
      while (p.launched < p.count && p.timer >= p.launched * LAUNCH_GAP_MS) {
        board.balls.push({
          x: board.launcherX * w,
          y: h - R * 3,
          vx: p.dx * speed,
          vy: p.dy * speed,
        });
        p.launched++;
      }
      if (p.launched >= p.count) board.pendingLaunch = null;
    }

    const cellW = w / COLS;
    const rowAreaTop = 0;
    const rowAreaH = h - R * 6;
    const cellH = rowAreaH / ROWS;
    const landed = [];

    for (let i = board.balls.length - 1; i >= 0; i--) {
      const b = board.balls[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x < R) { b.x = R; b.vx *= -1; }
      if (b.x > w - R) { b.x = w - R; b.vx *= -1; }
      if (b.y < R) { b.y = R; b.vy *= -1; }

      // 벽돌 충돌 체크
      const col = Math.floor(b.x / cellW);
      const row = Math.floor((b.y - rowAreaTop) / cellH);
      if (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
        const val = board.grid[row][col];
        if (val !== 0) {
          const cx = col * cellW + cellW / 2;
          const cy = rowAreaTop + row * cellH + cellH / 2;
          const dx = b.x - cx, dy = b.y - cy;
          if (Math.abs(dx / cellW) > Math.abs(dy / cellH)) b.vx *= -1;
          else b.vy *= -1;

          if (val === -1) {
            board.grid[row][col] = 0;
            board.pickupHitThisShot = true;
            board.score += 15;
          } else {
            const nv = val - 1;
            board.grid[row][col] = nv;
            board.score += 10;
            if (nv <= 0) board.grid[row][col] = 0;
          }
          board.flashRow = row;
          board.flashTimer = 120;
        }
      }

      // 바닥 도달 -> 착지
      if (b.y >= h - R * 3) {
        landed.push(b.x / w);
        board.balls.splice(i, 1);
      }
    }

    if (board.flashTimer > 0) board.flashTimer -= dt;

    if (landed.length) {
      board.landedX = (board.landedX || []).concat(landed);
    }

    // 모든 공이 소진되고, 발사 대기가 끝났고, 착지 기록이 있으면 샷 종료 처리
    if (board.shotInProgress && board.balls.length === 0 && !board.pendingLaunch) {
      resolveShot(board);
    }
  }

  function resolveShot(board) {
    board.shotInProgress = false;
    if (board.landedX && board.landedX.length) {
      const avg = board.landedX.reduce((a, b) => a + b, 0) / board.landedX.length;
      board.launcherX = Math.min(0.92, Math.max(0.08, avg));
    }
    board.landedX = [];

    if (board.pickupHitThisShot) {
      board.ballCount += 1;
      board.pickupHitThisShot = false;
    }

    // 패배 판정: 마지막 줄(바닥 바로 위)에 벽돌이 남아있으면 패배
    const loseRow = board.grid[ROWS - 1];
    const hasBrickAtBottom = loseRow.some(v => v !== 0);
    if (hasBrickAtBottom) {
      board.alive = false;
      if (board.isLocal) {
        showBoardStatus("me", "GAME OVER");
        finishLocal(false);
      }
      sendBoardUpdate(board);
      return;
    }

    // 기존 줄들은 한 칸씩 아래(패배 라인 쪽)로 내리고, 새 줄은 맨 위(안전한 곳)에 생성
    // 방금 검사한 맨 아래 줄은 비어있는 게 확인됐으므로 안전하게 제거
    board.grid.pop();
    board.grid.unshift(generateRow(state.rng, board.round++));

    if (board.isLocal) sendBoardUpdate(board);
  }

  function sendBoardUpdate(board) {
    sendSafe({
      t: "update",
      grid: board.grid,
      round: board.round,
      score: board.score,
      ballCount: board.ballCount,
      alive: board.alive,
    });
  }

  function sendSafe(payload) {
    if (state.conn && state.conn.open) {
      try { state.conn.send(payload); } catch (e) { /* noop */ }
    }
  }

  /* ---------------------------------------------------------------------
     9. 입력 (스와이프 조준 & 발사)
  --------------------------------------------------------------------- */
  function bindInput() {
    const canvas = el("canvas-me");
    let dragStart = null;

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return {
        x: (p.clientX - rect.left) / rect.width * canvas.width,
        y: (p.clientY - rect.top) / rect.height * canvas.height,
      };
    };

    const onDown = (e) => {
      if (!state.me.alive || state.me.shotInProgress) return;
      dragStart = getPos(e);
      state.me.aiming = true;
      state.me.aimVec = null;
    };
    const onMove = (e) => {
      if (!dragStart) return;
      e.preventDefault();
      const p = getPos(e);
      let dx = dragStart.x - p.x;
      let dy = dragStart.y - p.y;
      if (dy > -10) dy = -10; // 항상 위쪽으로만 발사
      const len = Math.hypot(dx, dy) || 1;
      state.me.aimVec = { dx: dx / len, dy: dy / len };
    };
    const onUp = () => {
      if (dragStart && state.me.aimVec && state.me.alive && !state.me.shotInProgress) {
        launchShot(state.me, state.me.aimVec);
      }
      dragStart = null;
      state.me.aiming = false;
      state.me.aimVec = null;
    };

    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("touchstart", onDown, { passive: true });
    canvas.addEventListener("touchmove", onMove, { passive: false });
    canvas.addEventListener("touchend", onUp);
  }

  function launchShot(board, vec) {
    board.shotInProgress = true;
    board.pendingLaunch = { dx: vec.dx, dy: vec.dy, count: board.ballCount, launched: 0, timer: 0 };
  }

  /* ---------------------------------------------------------------------
     10. 렌더링
  --------------------------------------------------------------------- */
  function resizeCanvases() {
    [el("canvas-me"), el("canvas-opp")].forEach((c) => {
      const wrap = c.parentElement;
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
    });
  }
  window.addEventListener("resize", () => { if (state.me) resizeCanvases(); });

  function render(board, isOpp) {
    const ctx = board.ctx;
    const w = board.canvas.width, h = board.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 배경 은은한 그리드
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(0, 0, w, h);

    const cellW = w / COLS;
    const rowAreaH = h - w * BALL_RADIUS_RATIO * 6;
    const cellH = rowAreaH / ROWS;
    const accent = isOpp ? "#ff7a59" : "#4ce0d2";

    // 패배 라인 표시
    ctx.strokeStyle = "rgba(255,77,109,0.35)";
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(0, ROWS * cellH);
    ctx.lineTo(w, ROWS * cellH);
    ctx.stroke();
    ctx.setLineDash([]);

    // 벽돌
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const val = board.grid?.[r]?.[c] ?? 0;
        if (!val) continue;
        const x = c * cellW, y = r * cellH;
        const pad = cellW * 0.07;
        ctx.beginPath();
        const rad = Math.min(cellW, cellH) * 0.18;
        roundRect(ctx, x + pad, y + pad, cellW - pad * 2, cellH - pad * 2, rad);
        if (val === -1) {
          ctx.fillStyle = PICKUP_COLOR;
        } else {
          const colorIdx = Math.min(BRICK_COLORS.length - 1, Math.floor(val / 6));
          ctx.fillStyle = BRICK_COLORS[colorIdx];
        }
        ctx.globalAlpha = board.flashRow === r && board.flashTimer > 0 ? 0.55 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;

        ctx.fillStyle = "rgba(10,7,26,0.75)";
        ctx.font = `${Math.floor(cellH * 0.36)}px 'JetBrains Mono', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(val === -1 ? "+1" : String(val), x + cellW / 2, y + cellH / 2 + 1);
      }
    }

    // 공 (로컬 보드만 실제 시뮬레이션 존재)
    if (!isOpp) {
      const R = w * BALL_RADIUS_RATIO;
      ctx.fillStyle = "#ffffff";
      board.balls.forEach((b) => {
        ctx.beginPath();
        ctx.arc(b.x, b.y, R, 0, Math.PI * 2);
        ctx.fill();
      });

      // 런처
      ctx.fillStyle = accent;
      const lx = board.launcherX * w;
      ctx.beginPath();
      ctx.arc(lx, h - R * 3, R * 1.4, 0, Math.PI * 2);
      ctx.fill();

      // 조준선
      if (board.aiming && board.aimVec) {
        drawAimLine(ctx, lx, h - R * 3, board.aimVec, w, h, R, board.grid, cellW, cellH);
      }
    } else {
      // 상대 보드는 남은 공 개수만 아이콘으로 표시
      const R = w * BALL_RADIUS_RATIO;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(w / 2, h - R * 3, R * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 공 개수 뱃지
    ctx.fillStyle = "rgba(244,241,255,0.85)";
    ctx.font = `600 ${Math.floor(w * 0.045)}px 'Space Grotesk', sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`● x${board.ballCount ?? 1}`, w - 10, h - 10);
  }

  function drawAimLine(ctx, x, y, vec, w, h, R, grid, cellW, cellH) {
    let px = x, py = y, dx = vec.dx, dy = vec.dy;
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.setLineDash([5, 7]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    let steps = 0;
    while (steps < 400) {
      steps++;
      px += dx * 6;
      py += dy * 6;
      if (px < R) { px = R; dx *= -1; }
      if (px > w - R) { px = w - R; dx *= -1; }
      if (py < R) { py = R; break; }
      ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function showBoardStatus(who, text) {
    const box = el(`status-${who}`);
    box.textContent = text;
    box.hidden = false;
  }

  /* ---------------------------------------------------------------------
     11. HUD / 타이머 / 상대 축약 바
  --------------------------------------------------------------------- */
  function updateHud() {
    if (!state.me || !state.opp) return;
    el("hud-score-me").textContent = state.me.score;
    el("hud-score-opp").textContent = state.opp.score;
  }

  function updateCompactOpp() {
    if (!state.opp) return;
    el("opp-compact-score").textContent = `${state.opp.score}점`;
    const total = ROWS * COLS;
    let filled = 0;
    (state.opp.grid || []).forEach(row => row.forEach(v => { if (v !== 0) filled++; }));
    const pct = Math.min(100, Math.round((filled / total) * 100));
    el("opp-compact-bar").style.width = pct + "%";
  }

  function updateTimerUI(remainMs) {
    const totalSec = Math.ceil(remainMs / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    const timerEl = el("hud-timer");
    timerEl.textContent = `${m}:${s}`;
    timerEl.classList.toggle("warn", totalSec <= 15);
  }

  /* ---------------------------------------------------------------------
     12. 매치 종료 / 결과 처리
  --------------------------------------------------------------------- */
  function finishLocal(alive) {
    if (state.finished) return;
    state.finished = true;
    state.myFinal = { score: state.me.score, alive };
    sendSafe({ t: "final", score: state.me.score, alive });
    maybeShowResult();
  }

  function endMatchByDisconnect() {
    state.running = false;
    cancelAnimationFrame(state.rafId);
    if (!state.finished) {
      state.myFinal = state.myFinal || { score: state.me ? state.me.score : 0, alive: state.me ? state.me.alive : false };
      state.oppFinal = { score: state.opp ? state.opp.score : 0, alive: false };
      state.finished = true;
      showResult(true);
    }
  }

  function maybeShowResult() {
    if (state.myFinal && state.oppFinal) {
      state.running = false;
      cancelAnimationFrame(state.rafId);
      showResult(false);
    } else if (state.myFinal) {
      // 상대 응답을 잠시 기다렸다가 강제로 표시
      setTimeout(() => {
        if (!state.oppFinal) {
          state.oppFinal = { score: state.opp.score, alive: state.opp.alive };
          state.running = false;
          cancelAnimationFrame(state.rafId);
          showResult(false);
        }
      }, 2500);
    }
  }

  function showResult(disconnected) {
    const myScore = state.myFinal.score;
    const oppScore = state.oppFinal.score;
    const myAlive = state.myFinal.alive;
    const oppAlive = state.oppFinal.alive;

    let outcome, reason;
    if (!myAlive && oppAlive) { outcome = "lose"; reason = "내 보드가 바닥까지 벽돌로 가득 찼어요"; }
    else if (myAlive && !oppAlive) { outcome = "win"; reason = disconnected ? "상대방 연결이 끊어졌어요" : "상대 보드가 먼저 가득 찼어요"; }
    else if (myScore === oppScore) { outcome = "draw"; reason = "점수가 동일해요"; }
    else if (myScore > oppScore) { outcome = "win"; reason = "제한시간 종료 · 더 높은 점수를 기록했어요"; }
    else { outcome = "lose"; reason = "제한시간 종료 · 상대 점수가 더 높았어요"; }

    const titleEl = el("result-title");
    titleEl.className = "result-title " + outcome;
    titleEl.textContent = outcome === "win" ? "승리!" : outcome === "lose" ? "패배" : "무승부";
    el("result-reason").textContent = reason;
    el("result-score-me").textContent = myScore;
    el("result-score-opp").textContent = oppScore;
    el("rematch-status").textContent = "";
    showScreen("result");
  }

  /* ---------------------------------------------------------------------
     13. 재대결
  --------------------------------------------------------------------- */
  el("btn-rematch").addEventListener("click", () => {
    state.rematchWanted = true;
    el("btn-rematch").disabled = true;
    el("btn-rematch").textContent = "상대 응답 대기 중...";
    el("rematch-status").textContent = state.oppRematchWanted ? "곧 새 대결이 시작돼요..." : "상대방의 응답을 기다리는 중...";
    sendSafe({ t: "rematch" });
    maybeRematch();
  });

  function maybeRematch() {
    if (state.rematchWanted && state.oppRematchWanted) {
      el("btn-rematch").disabled = false;
      el("btn-rematch").textContent = "다시 대결하기";
      if (state.role === "host") {
        const seed = Math.floor(Math.random() * 2 ** 31);
        const startAt = Date.now() + 3200;
        state.seed = seed;
        state.startAt = startAt;
        sendSafe({ t: "start", seed, startAt, hostName: state.myName });
        beginMatchFlow();
      }
      // guest는 host가 보내는 'start' 메시지를 받으면 beginMatchFlow 실행됨
    }
  }

  /* ---------------------------------------------------------------------
     디버그 훅 (테스트 전용, ?debug=1 로 접속할 때만 활성화되며
     실제 서비스 동작에는 영향을 주지 않음)
  --------------------------------------------------------------------- */
  if (location.search.includes("debug=1")) {
    window.__debug = { state, beginMatchFlow, showScreen, generateRow, mulberry32, wireConnection, resolveShot };
  }

})();
