import { randomBytes, randomInt } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  GameView,
  LogEntry,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NIGHT_ORDER,
  NightStep,
  NightStatus,
  Phase,
  Role,
  Settings,
  VoteResult,
} from './types.js';

export class GameError extends Error {}

interface Player {
  id: string; // 공개 ID (다른 사람에게 보임)
  token: string; // 비밀 토큰 (본인 기기에만 저장, 재접속용)
  name: string;
  socketId: string | null;
  connected: boolean;
  alive: boolean;
  role: Role | null;
}

export const ROLE_NAMES: Record<Role, string> = {
  mafia: '마피아',
  spy: '스파이',
  citizen: '시민',
  police: '경찰',
  doctor: '의사',
  politician: '정치인',
  gangster: '깡패',
};

const SETTING_LIMITS: Record<keyof Settings, [number, number]> = {
  mafia: [1, 3],
  spy: [0, 1],
  police: [0, 2],
  doctor: [0, 2],
  politician: [0, 1],
  gangster: [0, 1],
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Room {
  readonly code: string;
  hostId = '';
  players: Player[] = [];
  settings: Settings = { ...DEFAULT_SETTINGS };
  phase: Phase = 'lobby';
  day = 0;
  endsAt: number | null = null;
  winner: 'mafia' | 'citizen' | null = null;
  lastActive = Date.now();

  private picks = new Map<string, string>();
  private confirmed = new Set<string>();
  /** 능력이 없는 생존자가 이번 차례에 '다음'을 누른 횟수와 두 번째 활성화 시각 */
  private taps = new Map<string, number>();
  private tapReadyAt = new Map<string, number>();
  private introReady = new Set<string>();
  private lastHeals = new Map<string, string>();
  // 밤
  private nightSteps: NightStep[] = [];
  private stepIndex = 0;
  private mafiaTarget: string | null = null;
  private doctorTargets = new Map<string, string>();
  private policeChecks = new Map<string, string>();
  private gangsterTargets = new Map<string, string>();
  private spyChecks = new Map<string, string>();
  private spyContacted = new Set<string>(); // 마피아와 접선한 스파이
  /** 깡패에게 지목당한 사람: 다음 날 투표 무효 + 그날 밤까지 능력 사용 불가 */
  private threatened = new Set<string>();
  // 낮
  private votes = new Map<string, string | null>();
  private voteResult: VoteResult | null = null;
  private accusedId: string | null = null;
  private finalVotes = new Map<string, boolean>();
  // 기록
  private log: LogEntry[] = [];
  private seq = 0;

  constructor(code: string, private onChange: (room: Room) => void) {
    this.code = code;
  }

  // ───────────────────────── 헬퍼 ─────────────────────────

  private emit() {
    this.lastActive = Date.now();
    this.onChange(this);
  }

  private byToken(token: string): Player {
    const p = this.players.find((x) => x.token === token);
    if (!p) throw new GameError('방에 참가하지 않은 플레이어입니다.');
    return p;
  }

  private byId(id: string | null | undefined): Player | undefined {
    return this.players.find((x) => x.id === id);
  }

  private alive() {
    return this.players.filter((p) => p.alive);
  }

  /** 마피아 + 접선한 스파이 = 실제로 함께 처치하는 마피아 팀 */
  private isMafiaSide(p: Player) {
    return p.role === 'mafia' || (p.role === 'spy' && this.spyContacted.has(p.id));
  }

  private mafiaSideIds() {
    return this.players.filter((p) => this.isMafiaSide(p)).map((p) => p.id);
  }

  private addLog(text: string, kind: LogEntry['kind'] = 'system', to?: string[]) {
    this.log.push({ id: ++this.seq, day: this.day, text, kind, to });
    if (this.log.length > 300) this.log.shift();
  }

  private requireHost(token: string) {
    const p = this.byToken(token);
    if (p.id !== this.hostId) throw new GameError('방장만 할 수 있습니다.');
    return p;
  }

  /** 깡패에게 지목당한 사람의 표는 무효(0표), 정치인은 2표 */
  private voteWeight(p: Player) {
    if (this.threatened.has(p.id)) return 0;
    return p.role === 'politician' ? 2 : 1;
  }

  private setPhase(phase: Phase, _seconds?: unknown) {
    this.phase = phase;
    this.endsAt = null;
  }

  destroy() {}

  hostNext(token: string) {
    this.requireHost(token);
    switch (this.phase) {
      case 'day': this.startVote(); break;
      case 'vote': this.resolveVote(); break;
      case 'voteResult': this.accusedId ? this.startDefense() : this.goNextNight(); break;
      case 'defense': this.startFinal(); break;
      case 'final': this.resolveFinal(); break;
      case 'execution': this.afterExecution(); break;
      default: throw new GameError('지금은 방장이 넘길 차례가 아닙니다.');
    }
    this.emit();
  }

  // ───────────────────────── 로비 ─────────────────────────

  join(token: string, rawName: string, socketId: string): Player {
    const existing = this.players.find((p) => p.token === token);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      this.emit();
      return existing;
    }
    if (this.phase !== 'lobby') throw new GameError('이미 게임이 진행 중입니다.');
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`방이 가득 찼습니다 (최대 ${MAX_PLAYERS}명).`);
    const name = rawName.trim().slice(0, 12);
    if (!name) throw new GameError('이름을 입력하세요.');
    if (this.players.some((p) => p.name === name)) throw new GameError('이미 사용 중인 이름입니다.');

    const player: Player = {
      id: randomBytes(4).toString('hex'),
      token,
      name,
      socketId,
      connected: true,
      alive: true,
      role: null,
    };
    this.players.push(player);
    if (!this.hostId || !this.byId(this.hostId)) this.hostId = player.id;
    this.emit();
    return player;
  }

  disconnect(socketId: string) {
    const p = this.players.find((x) => x.socketId === socketId);
    if (!p) return;
    p.socketId = null;
    p.connected = false;
    this.emit();
  }

  leave(token: string) {
    const p = this.byToken(token);
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x !== p);
    } else {
      p.socketId = null;
      p.connected = false;
    }
    if (this.hostId === p.id) {
      const next = this.players.find((x) => x !== p && x.connected) ?? this.players.find((x) => x !== p);
      this.hostId = next?.id ?? '';
    }
    this.emit();
  }

  kick(token: string, targetId: string) {
    this.requireHost(token);
    if (this.phase !== 'lobby') throw new GameError('대기실에서만 강퇴할 수 있습니다.');
    const t = this.byId(targetId);
    if (!t || t.id === this.hostId) return null;
    this.players = this.players.filter((x) => x !== t);
    this.emit();
    return t.socketId;
  }

  updateSettings(token: string, patch: Partial<Settings>) {
    this.requireHost(token);
    if (this.phase !== 'lobby') throw new GameError('대기실에서만 설정을 바꿀 수 있습니다.');
    for (const key of Object.keys(SETTING_LIMITS) as (keyof Settings)[]) {
      const v = patch[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const [min, max] = SETTING_LIMITS[key];
      this.settings[key] = Math.max(min, Math.min(max, Math.round(v)));
    }
    this.emit();
  }

  static validateRoles(s: Settings, playerCount: number): string | null {
    if (playerCount < MIN_PLAYERS) return `최소 ${MIN_PLAYERS}명이 필요합니다.`;
    const special = s.mafia + s.spy + s.police + s.doctor + s.politician + s.gangster;
    if (special > playerCount) return '직업 수가 인원보다 많습니다.';
    if ((s.mafia + s.spy) * 2 >= playerCount) return '마피아팀(마피아+스파이)은 전체 인원의 절반보다 적어야 합니다.';
    return null;
  }

  start(token: string) {
    this.requireHost(token);
    if (this.phase !== 'lobby' && this.phase !== 'ended') throw new GameError('이미 게임이 진행 중입니다.');
    const err = Room.validateRoles(this.settings, this.players.length);
    if (err) throw new GameError(err);

    const s = this.settings;
    const roles: Role[] = [];
    const add = (role: Role, n: number) => {
      for (let i = 0; i < n; i++) roles.push(role);
    };
    add('mafia', s.mafia);
    add('spy', s.spy);
    add('police', s.police);
    add('doctor', s.doctor);
    add('politician', s.politician);
    add('gangster', s.gangster);
    add('citizen', this.players.length - roles.length);
    const shuffled = shuffle(roles);

    this.log = [];
    this.winner = null;
    this.day = 1;
    this.threatened.clear();
    this.spyContacted.clear();
    this.players.forEach((p, i) => {
      p.alive = true;
      p.role = shuffled[i];
    });
    // 이번 게임에 존재하는 직업의 차례만 진행 (죽어도 차례는 계속 진행됨)
    this.nightSteps = NIGHT_ORDER.filter((r) => s[r] > 0);

    this.addLog(`게임이 시작되었습니다. (${this.players.length}명)`);
    for (const p of this.players) {
      this.addLog(`당신의 직업은 [${ROLE_NAMES[p.role!]}]입니다.`, 'private', [p.id]);
    }
    const mafia = this.players.filter((p) => p.role === 'mafia');
    if (mafia.length > 1) {
      this.addLog(`동료 마피아: ${mafia.map((m) => m.name).join(', ')}`, 'private', mafia.map((m) => m.id));
    }
    this.picks.clear();
    this.confirmed.clear();
    this.introReady.clear();
    this.lastHeals.clear();
    this.votes.clear();
    this.finalVotes.clear();
    this.voteResult = null;
    this.accusedId = null;
    this.setPhase('intro');
    this.emit();
  }

  /** 방장이 게임을 중단하거나, 종료 후 대기실로 돌아감 */
  backToLobby(token: string) {
    this.requireHost(token);
    this.phase = 'lobby';
    this.endsAt = null;
    this.day = 0;
    this.winner = null;
    this.accusedId = null;
    this.voteResult = null;
    this.threatened.clear();
    this.spyContacted.clear();
    this.log = [];
    this.players = this.players.filter((p) => p.connected);
    for (const p of this.players) {
      p.alive = true;
      p.role = null;
    }
    if (!this.byId(this.hostId)) this.hostId = this.players[0]?.id ?? '';
    this.emit();
  }

  // ───────────────────────── 밤 ─────────────────────────

  private get nightStep(): NightStep | null {
    return this.phase === 'night' ? (this.nightSteps[this.stepIndex] ?? null) : null;
  }

  private startNight() {
    this.mafiaTarget = null;
    this.doctorTargets.clear();
    this.policeChecks.clear();
    this.gangsterTargets.clear();
    this.spyChecks.clear();
    this.accusedId = null;
    this.voteResult = null;
    this.votes.clear();
    this.finalVotes.clear();
    this.stepIndex = 0;
    this.addLog(`🌙 ${this.day}번째 밤이 되었습니다.`);
    this.resetStepProgress();
    this.setPhase('night');
  }

  private resetStepProgress() {
    this.picks.clear();
    this.confirmed.clear();
    this.taps.clear();
    this.tapReadyAt.clear();
  }

  private nextNightStep() {
    this.resetStepProgress();
    this.stepIndex += 1;
    if (this.stepIndex >= this.nightSteps.length) this.resolveNight();
  }

  private isMyStep(p: Player, step: NightStep | null) {
    return !!step && (step === 'mafia' ? this.isMafiaSide(p) : p.role === step);
  }

  /**
   * 사망자는 밤에 아무것도 하지 않는다. 생존자 중 이번 차례 직업이면 'pick',
   * 나머지는 모두 '다음'을 두 번 눌러 위장한다 (협박/접선으로 능력을 못 쓰는 경우 포함).
   */
  private nightStatus(p: Player): NightStatus {
    if (!p.alive) return 'dead';
    if (!this.isMyStep(p, this.nightStep)) return 'wait';
    if (this.threatened.has(p.id)) return 'blocked';
    if (this.nightStep === 'spy' && this.spyContacted.has(p.id)) return 'contacted';
    return 'pick';
  }

  /** 실제로 능력을 쓰는 사람 (살아있고, 협박/접선 상태가 아닌 이번 차례 직업) */
  private actors() { return this.players.filter(p => this.nightStatus(p) === 'pick'); }

  private stepDoneFor(p: Player) {
    const status = this.nightStatus(p);
    if (status === 'dead') return true;
    if (status === 'pick') return this.confirmed.has(p.id);
    return (this.taps.get(p.id) ?? 0) >= 2;
  }

  nightPick(token: string, targetId: string) {
    const me = this.byToken(token);
    if (this.nightStatus(me) !== 'pick') throw new GameError('지금은 선택할 수 없습니다.');
    const target = this.byId(targetId);
    if (!target?.alive) throw new GameError('살아있는 사람을 선택하세요.');
    const step = this.nightStep!;
    if (step === 'mafia' && this.isMafiaSide(target)) throw new GameError('같은 마피아 팀은 선택할 수 없습니다.');
    if (step !== 'mafia' && step !== 'doctor' && target.role === step) throw new GameError('같은 직업은 선택할 수 없습니다.');
    if (step === 'doctor' && this.lastHeals.get(me.id) === target.id) throw new GameError('연속으로 같은 사람을 치료할 수 없습니다.');
    if (this.picks.get(me.id) !== targetId) {
      this.picks.set(me.id, targetId);
      this.confirmed.clear();
    }
    this.emit();
  }

  nightNext(token: string) {
    const me = this.byToken(token);
    if (this.phase === 'intro') {
      this.introReady.add(me.id);
      if (this.players.every(p => this.introReady.has(p.id))) {
        this.day = 2;
        this.addLog('첫날 밤이 지나고 둘째 날 낮이 되었습니다. 토론을 시작하세요.');
        this.setPhase('day');
      }
      this.emit();
      return;
    }
    if (this.phase !== 'night') throw new GameError('밤이 아닙니다.');
    const status = this.nightStatus(me);
    if (status === 'dead') throw new GameError('사망한 플레이어는 밤에 누를 필요가 없습니다.');
    const actors = this.actors();
    if (status === 'pick') {
      const target = this.picks.get(me.id);
      if (!target || actors.some(p => this.picks.get(p.id) !== target)) throw new GameError('동료 모두 같은 사람을 선택해야 합니다.');
      this.confirmed.add(me.id);
    } else {
      const n = this.taps.get(me.id) ?? 0;
      if (n >= 2) throw new GameError('이미 완료했습니다. 다른 사람을 기다려 주세요.');
      if (n === 1 && Date.now() < (this.tapReadyAt.get(me.id) ?? 0)) throw new GameError('잠시 후 다시 눌러주세요.');
      this.taps.set(me.id, n + 1);
      if (n === 0) this.tapReadyAt.set(me.id, Date.now() + randomInt(1000, 5001));
    }
    // 살아있는 모든 사람이 할 일을 마치면 다음 차례로 (사망자는 기다리지 않음)
    if (this.players.every(p => this.stepDoneFor(p))) {
      this.applyNightStep(actors);
      this.nextNightStep();
    }
    this.emit();
  }

  /** 연결 끊김 등으로 막힌 차례를 방장이 명시적으로 건너뜀. 미완료 능력은 실행하지 않음. */
  hostSkipNightStep(token: string) {
    this.requireHost(token);
    if (this.phase === 'intro') {
      this.day = 2;
      this.setPhase('day');
      this.addLog('첫날 밤이 지나고 둘째 날 낮이 되었습니다.');
    } else if (this.phase === 'night') {
      if (this.nightStep === 'doctor') this.lastHeals.clear();
      this.nextNightStep();
    } else throw new GameError('밤에만 건너뛸 수 있습니다.');
    this.emit();
  }

  private applyNightStep(active: Player[]) {
    const step = this.nightStep;
    if (step === 'doctor') this.lastHeals.clear();
    for (const me of active) {
      const target = this.byId(this.picks.get(me.id));
      if (!target) continue;
      switch (step) {
        case 'mafia': this.mafiaTarget = target.id; break;
        case 'doctor':
          this.doctorTargets.set(me.id, target.id);
          this.lastHeals.set(me.id, target.id);
          break;
        case 'gangster': this.gangsterTargets.set(me.id, target.id); break;
        case 'police':
          this.addLog(`[${target.name}]님은 ${target.role === 'mafia' ? '마피아입니다.' : '마피아가 아닙니다.'}`, 'result', [me.id]);
          break;
        case 'spy':
          if (target.role === 'mafia') {
            this.spyContacted.add(me.id);
            this.addLog(`접선 성공! [${target.name}]님은 마피아입니다. 이제 함께 처치 대상을 고릅니다.`, 'result', [me.id]);
            this.addLog(`스파이 [${me.name}]님이 접선했습니다.`, 'result', this.players.filter(p => p.role === 'mafia').map(p => p.id));
          } else this.addLog(`[${target.name}]님은 마피아가 아닙니다.`, 'result', [me.id]);
          break;
      }
    }
  }

  private resolveNight() {
    const healed = new Set(this.doctorTargets.values());
    const victim = this.byId(this.mafiaTarget);

    this.day += 1;
    this.addLog(`☀️ ${this.day}번째 낮이 밝았습니다.`);
    if (victim && victim.alive) {
      if (healed.has(victim.id)) {
        this.addLog(`💉 [${victim.name}]님이 의사의 치료를 받고 살아났습니다!`, 'save');
      } else {
        victim.alive = false;
        this.addLog(`🔪 [${victim.name}]님이 마피아에게 살해당했습니다.`, 'death');
      }
    } else {
      this.addLog('조용한 밤이 지나갔습니다. 아무도 죽지 않았습니다.');
    }

    // 지난 협박은 이번 밤으로 끝나고, 오늘 밤 지목된 사람이 새로 협박당함
    this.threatened = new Set([...this.gangsterTargets.values()].filter((id) => this.byId(id)?.alive));
    for (const id of this.threatened) {
      this.addLog('😠 깡패에게 지목당했습니다. 오늘 투표는 무효 처리되고, 오늘 밤 능력을 사용할 수 없습니다.', 'private', [id]);
    }

    if (this.checkWin()) return;
    this.setPhase('day', null);
  }

  // ───────────────────────── 낮 / 투표 ─────────────────────────

  /** 투표 화면은 살아있는 모두에게 똑같이 보임 (협박당한 사람도 투표는 하지만 무효표) */
  private voters() {
    return this.alive();
  }

  private startVote() {
    this.votes.clear();
    this.addLog('🗳 투표 시간입니다. 최후의 반론을 할 사람을 지목하세요.');
    this.setPhase('vote', null);
  }

  vote(token: string, targetId: string | null) {
    if (this.phase !== 'vote') throw new GameError('투표 시간이 아닙니다.');
    const me = this.byToken(token);
    if (!me.alive) throw new GameError('사망한 플레이어입니다.');
    if (targetId != null) {
      const t = this.byId(targetId);
      if (!t || !t.alive) throw new GameError('살아있는 플레이어를 선택하세요.');
    }
    this.votes.set(me.id, targetId);
    this.emit();
  }

  private resolveVote() {
    const counts: Record<string, number> = {};
    for (const [voterId, targetId] of this.votes) {
      const voter = this.byId(voterId);
      if (!voter || !targetId) continue;
      const w = this.voteWeight(voter);
      if (w > 0) counts[targetId] = (counts[targetId] ?? 0) + w;
    }
    const threshold = Math.ceil(this.alive().length / 2);
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top = sorted[0];

    let reason: VoteResult['reason'] = 'ok';
    if (!top) reason = 'none';
    else if (sorted[1] && sorted[1][1] === top[1]) reason = 'tie';
    else if (top[1] < threshold) reason = 'notEnough';

    this.accusedId = reason === 'ok' ? top[0] : null;
    this.voteResult = { counts, threshold, accusedId: this.accusedId, reason };

    const summary = sorted.map(([id, n]) => `${this.byId(id)?.name} ${n}표`).join(', ') || '득표 없음';
    this.addLog(`🗳 투표 결과: ${summary}`, 'vote');
    if (reason === 'ok') {
      this.addLog(`📢 [${this.byId(top[0])?.name}]님이 최후의 반론을 합니다.`, 'vote');
    } else {
      const why =
        reason === 'tie'
          ? '최다 득표가 동률이라'
          : reason === 'notEnough'
            ? `최다 득표가 생존자 절반(${threshold}표)에 못 미쳐`
            : '유효표가 없어';
      this.addLog(`${why} 투표가 무효 처리되었습니다. 밤이 됩니다.`, 'vote');
    }
    this.setPhase('voteResult', null);
  }

  private startDefense() {
    this.setPhase('defense', null);
  }

  private finalVoters() {
    return this.alive().filter((p) => p.id !== this.accusedId);
  }

  private startFinal() {
    this.finalVotes.clear();
    const accused = this.byId(this.accusedId);
    this.addLog(`⚖️ [${accused?.name}]님의 처형에 대한 찬반 투표를 시작합니다.`, 'vote');
    this.setPhase('final', null);
  }

  finalVote(token: string, agree: boolean) {
    if (this.phase !== 'final') throw new GameError('찬반 투표 시간이 아닙니다.');
    const me = this.byToken(token);
    if (!this.finalVoters().includes(me)) throw new GameError('투표할 수 없습니다.');
    this.finalVotes.set(me.id, !!agree);
    this.emit();
  }

  private resolveFinal() {
    const accused = this.byId(this.accusedId);
    let agree = 0;
    let disagree = 0;
    for (const [voterId, v] of this.finalVotes) {
      const voter = this.byId(voterId);
      if (!voter) continue;
      if (v) agree += this.voteWeight(voter);
      else disagree += this.voteWeight(voter);
    }
    const result = `(찬성 ${agree} / 반대 ${disagree})`;
    if (accused && accused.alive && agree > disagree) {
      // 정치인 면제도 '능력'이므로 협박당한 날에는 적용되지 않음
      if (accused.role === 'politician' && !this.threatened.has(accused.id)) {
        this.addLog(`🏛 [${accused.name}]님은 정치인이라 투표로 처형되지 않습니다! ${result}`, 'save');
      } else {
        accused.alive = false;
        this.addLog(`💀 [${accused.name}]님이 투표로 처형되었습니다. ${result}`, 'death');
      }
    } else {
      this.addLog(`[${accused?.name}]님이 처형을 면했습니다. ${result}`, 'vote');
    }
    this.setPhase('execution', null);
  }

  private afterExecution() {
    if (this.checkWin()) return;
    this.goNextNight();
  }

  private goNextNight() {
    this.startNight();
  }

  /**
   * 마피아팀 = 마피아 + 접선한 스파이. 접선 전 스파이는 인원에 포함하지 않는다.
   * 마피아팀이 전멸하면 시민 승리, 마피아팀 수 ≥ 나머지 수면 마피아 승리.
   */
  private checkWin(): boolean {
    const alive = this.alive();
    const mafia = alive.filter((p) => this.isMafiaSide(p)).length;
    const others = alive.length - mafia;
    if (mafia === 0) this.endGame('citizen');
    else if (mafia >= others) this.endGame('mafia');
    else return false;
    return true;
  }

  private endGame(winner: 'mafia' | 'citizen') {
    this.winner = winner;
    this.addLog(winner === 'mafia' ? '🩸 마피아 팀이 승리했습니다!' : '🎉 시민 팀이 승리했습니다!');
    this.setPhase('ended', null);
  }

  // ───────────────────────── 화면 데이터 ─────────────────────────

  socketIds() {
    return this.players.filter((p) => p.socketId).map((p) => [p.socketId!, p.token] as const);
  }

  hasConnected() {
    return this.players.some((p) => p.connected);
  }

  viewFor(token: string): GameView {
    const me = this.byToken(token);
    const ended = this.phase === 'ended';
    const iAmMafiaSide = this.isMafiaSide(me);
    const step = this.nightStep;

    const status = this.phase === 'night' ? this.nightStatus(me) : 'wait';
    const active = this.phase === 'night' ? this.actors() : [];
    const myPick = this.picks.get(me.id) ?? null;
    const same = !!myPick && active.every(p => this.picks.get(p.id) === myPick);
    const myTaps = this.taps.get(me.id) ?? 0;
    const tapReadyInMs = myTaps === 1 ? Math.max(0, (this.tapReadyAt.get(me.id) ?? 0) - Date.now()) : null;
    const stepDone = step ? this.stepDoneFor(me) : false;
    const popup = [...this.log].reverse().find(l => l.kind === 'result' && l.to?.includes(me.id));
    const dayPhases: Phase[] = ['day', 'vote', 'voteResult', 'defense', 'final', 'execution'];
    const voters = this.phase === 'final' ? this.finalVoters() : this.voters();
    const votedCount =
      this.phase === 'final'
        ? this.finalVotes.size
        : this.phase === 'vote'
          ? voters.filter((p) => this.votes.has(p.id)).length
          : 0;

    return {
      code: this.code,
      phase: this.phase,
      day: this.day,
      settings: this.settings,
      hostId: this.hostId,
      me: { id: me.id, name: me.name, role: me.role, alive: me.alive, isHost: me.id === this.hostId },
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        isHost: p.id === this.hostId,
        role: p.id === me.id || ended || (iAmMafiaSide && this.isMafiaSide(p)) || (this.phase !== 'lobby' && me.role !== 'citizen' && me.role === p.role) ? (p.role ?? undefined) : undefined,
      })),
      introConfirmed: this.introReady.has(me.id),
      night: step ? {
        step, index: this.stepIndex, count: this.nightSteps.length, status,
        myPick, confirmed: this.confirmed.has(me.id),
        canNext: status === 'pick' ? !this.confirmed.has(me.id) && same : status !== 'dead' && myTaps < 2,
        taps: myTaps,
        tapReadyInMs,
        done: stepDone,
        team: status === 'pick' ? active.filter(p => p.id !== me.id).map(p => ({id: p.id, name: p.name, pick: this.picks.get(p.id) ?? null, confirmed: this.confirmed.has(p.id)})) : [],
        blockedTarget: status === 'pick' && step === 'doctor' ? this.lastHeals.get(me.id) ?? null : null,
      } : null,
      popup: popup ? {id: popup.id, text: popup.text} : null,
      threatened: this.threatened.has(me.id) && me.alive && dayPhases.includes(this.phase),
      canVote: me.alive && voters.includes(me),
      myVote: this.votes.has(me.id) ? this.votes.get(me.id)! : undefined,
      votedCount,
      voterCount: voters.length,
      voteResult: this.phase === 'vote' ? null : this.voteResult,
      accusedId: this.accusedId,
      myFinal: this.finalVotes.has(me.id) ? this.finalVotes.get(me.id)! : null,
      log: this.log.filter((l) => !l.to || l.to.includes(me.id)).slice(-60).map(({ to, ...entry }) => entry),
      winner: this.winner,
    };
  }
}
