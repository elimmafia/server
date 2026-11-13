export type Role = 'mafia' | 'spy' | 'citizen' | 'police' | 'doctor' | 'politician' | 'gangster';

/** 밤에 차례대로 진행되는 직업 순서 (설정에 있는 직업만 진행, 죽었어도 차례는 그대로 진행) */
export const NIGHT_ORDER = ['spy', 'mafia', 'doctor', 'police', 'gangster'] as const;
export type NightStep = (typeof NIGHT_ORDER)[number];

export type Phase =
  | 'lobby'
  | 'intro' // 첫날 밤: 능력 없이 같은 직업끼리 확인만
  | 'night' // 밤: 직업별 차례 진행
  | 'day' // 낮: 토론
  | 'vote' // 투표: 최후의 반론 대상 지목
  | 'voteResult' // 투표 결과 표시
  | 'defense' // 최후의 반론
  | 'final' // 찬반 투표
  | 'execution' // 처형 결과 표시
  | 'ended';

export interface Settings {
  mafia: number;
  spy: number;
  police: number;
  doctor: number;
  politician: number;
  gangster: number;
}

export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 4;

export const DEFAULT_SETTINGS: Settings = {
  mafia: 2,
  spy: 0,
  police: 1,
  doctor: 1,
  politician: 0,
  gangster: 0,
};

export interface LogEntry {
  id: number;
  day: number;
  text: string;
  kind: 'system' | 'death' | 'save' | 'private' | 'result' | 'vote'; // result = 나만 보는 조사/접선 결과(팝업)
  to?: string[]; // 지정되면 해당 플레이어에게만 보임
}

export interface PublicPlayer {
  id: string;
  name: string;
  alive: boolean;
  connected: boolean;
  isHost: boolean;
  role?: Role; // 보이는 경우만
}

export interface VoteResult {
  counts: Record<string, number>; // 플레이어 id → 유효 득표수
  threshold: number; // 필요한 최소 득표 (생존자 절반 이상)
  accusedId: string | null;
  reason: 'ok' | 'tie' | 'notEnough' | 'none';
}

/** 밤 차례에서 내 상태 */
export type NightStatus =
  | 'wait' // 내 직업 차례가 아님 → '다음'을 두 번 눌러 위장
  | 'pick' // 대상을 고르고 '다음'
  | 'dead' // 사망: 밤에는 아무것도 누르지 않음
  | 'blocked' // 깡패에게 협박당해 능력 사용 불가 → '다음' 두 번
  | 'contacted'; // (스파이) 이미 접선함 → '다음' 두 번

export interface NightView {
  step: NightStep;
  index: number;
  count: number;
  status: NightStatus;
  canNext: boolean; // 지금 '다음'을 누를 수 있는지
  /** 능력이 없는 사람의 '다음' 누른 횟수 (0~2). 모든 생존자가 밤마다 두 번 누르게 해서 직업을 숨김 */
  taps: number;
  /** 두 번째 '다음'이 활성화되기까지 남은 시간(ms). 1~5초 무작위 */
  tapReadyInMs: number | null;
  done: boolean; // 이번 차례에서 내 할 일을 마쳤는지
  myPick: string | null;
  confirmed: boolean; // 내가 '다음'을 눌렀는지
  /** 함께 고르는 같은 직업 동료 (본인 제외). 모두 같은 사람을 고르고 '다음'을 눌러야 넘어감 */
  team: { id: string; name: string; pick: string | null; confirmed: boolean }[];
  blockedTarget: string | null; // (의사) 어젯밤 치료해서 오늘은 고를 수 없는 사람
}

export interface GameView {
  code: string;
  phase: Phase;
  day: number;
  settings: Settings;
  hostId: string;
  me: { id: string; name: string; role: Role | null; alive: boolean; isHost: boolean };
  players: PublicPlayer[];
  introConfirmed: boolean;
  night: NightView | null;
  popup: { id: number; text: string } | null; // 조사/접선 결과 팝업
  // 깡패
  threatened: boolean; // 오늘 깡패에게 지목당함 (투표 무효 + 능력 불가)
  // 투표
  canVote: boolean;
  myVote: string | null | undefined; // undefined = 아직 안함, null = 기권
  votedCount: number;
  voterCount: number;
  voteResult: VoteResult | null;
  accusedId: string | null;
  myFinal: boolean | null;
  log: LogEntry[];
  winner: 'mafia' | 'citizen' | null;
}
