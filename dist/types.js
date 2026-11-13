/** 밤에 차례대로 진행되는 직업 순서 (설정에 있는 직업만 진행, 죽었어도 차례는 그대로 진행) */
export const NIGHT_ORDER = ['spy', 'mafia', 'doctor', 'police', 'gangster'];
export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 4;
export const DEFAULT_SETTINGS = {
    mafia: 2,
    spy: 0,
    police: 1,
    doctor: 1,
    politician: 0,
    gangster: 0,
};
