import assert from 'node:assert/strict';
import { Room } from './game.js';
import type { Role } from './types.js';
function setup(roles: Role[]) {
  const room = new Room('TEST', () => {});
  const tokens = roles.map((_, i) => `token-${i}-xxxxxxxxxxxxxxxx`);
  tokens.forEach((t,i) => room.join(t, `P${i}`, `s${i}`));
  const settings = Object.fromEntries(['mafia','spy','police','doctor','politician','gangster'].map(r => [r, roles.filter(x=>x===r).length]));
  room.updateSettings(tokens[0], settings);
  room.start(tokens[0]);
  room.players.forEach((p,i)=>p.role=roles[i]);
  const r = room as any;
  const id = (i:number) => room.players[i].id;
  const v = (i:number) => room.viewFor(tokens[i]);
  const host = () => room.hostNext(tokens[0]);
  const intro = () => tokens.forEach(t => room.nightNext(t));
  const step = (role:string) => { while(r.nightStep!==role) room.hostSkipNightStep(tokens[0]); };
  const choose = (i:number,j:number) => room.nightPick(tokens[i],id(j));
  const next = (i:number) => room.nightNext(tokens[i]);
  /** 능력이 없는 생존자 전원이 '다음'을 두 번 누름 (테스트에서는 1~5초 대기를 건너뜀) */
  const dummies = () => {
    const at = `${room.day}-${r.stepIndex}-${room.phase}`;
    const list = tokens.map((t,i)=>({t,i,st:room.viewFor(t).night?.status})).filter(x=>x.st && x.st!=='pick' && x.st!=='dead');
    for (const x of list) {
      if (`${room.day}-${r.stepIndex}-${room.phase}` !== at) return;
      const pid = room.players[x.i].id;
      while ((r.taps.get(pid) ?? 0) < 2 && `${room.day}-${r.stepIndex}-${room.phase}` === at) {
        r.tapReadyAt.set(pid, 0); room.nightNext(x.t);
      }
    }
  };
  return {room,r,tokens,id,v,host,intro,step,choose,next,dummies};
}
{
  const g=setup(['mafia','mafia','doctor','doctor','police','police','citizen','citizen','citizen','citizen']);
  assert.equal(g.room.phase,'intro');
  assert.throws(()=>g.choose(0,6));
  assert.equal(g.v(2).players[3].role,'doctor');
  assert.equal(g.v(6).players.filter(p=>p.role).length,1);
  for(let i=0;i<9;i++) g.next(i);
  assert.equal(g.room.phase,'intro');
  g.next(9); assert.equal(g.room.phase,'day'); assert.equal(g.room.day,2);
  assert.throws(()=>g.room.hostNext(g.tokens[1]));
  assert.equal(g.room.endsAt,null);
  g.host(); g.host(); g.host(); // no votes -> night
  assert.equal(g.room.phase,'night');
  g.choose(0,6); g.choose(1,7);
  assert.throws(()=>g.next(0),'mismatched picks');
  g.choose(1,6); g.next(0);
  assert.equal(g.v(0).night!.confirmed,true);
  g.choose(1,7); assert.equal(g.v(0).night!.confirmed,false,'change resets confirmations');
  g.choose(1,6); g.next(0); g.next(1);
  assert.equal(g.v(2).night!.step,'mafia','능력 사용자만 끝나서는 넘어가지 않음');
  // 시민도 다음을 두 번: 두 번째는 1~5초 뒤에만 가능
  assert.equal(g.v(6).night!.canNext,true,'시민도 밤에 다음 버튼이 있음');
  g.next(6);
  assert.ok(g.v(6).night!.tapReadyInMs! >= 900 && g.v(6).night!.tapReadyInMs! <= 5000);
  assert.throws(()=>g.next(6),'두 번째 다음은 대기 후에만');
  g.dummies();
  assert.equal(g.v(2).night!.step,'doctor');
  g.choose(2,6); g.choose(3,6); g.next(2); g.next(3); g.dummies();
  g.choose(4,0); g.choose(5,0); g.next(4); g.next(5); g.dummies();
  assert.equal(g.room.players[6].alive,true,'heal saves');
  assert.ok(g.v(4).popup?.text.includes('마피아입니다'));
  assert.equal(g.v(6).popup,null);
  g.host(); g.host(); g.host();
  g.room.hostSkipNightStep(g.tokens[0]);
  assert.throws(()=>g.choose(2,6),'consecutive heal blocked');
  g.choose(2,2); g.choose(3,2); g.next(2); g.next(3); g.dummies();
  g.room.hostSkipNightStep(g.tokens[0]);
  g.host();g.host();g.host();g.room.hostSkipNightStep(g.tokens[0]);
  assert.throws(()=>g.choose(2,2),'consecutive self heal blocked');
  g.choose(2,6); // A B A allowed
}
{
  const g=setup(['mafia','spy','doctor','gangster','police','citizen','citizen']);
  g.intro();g.host();g.host();g.host();
  g.choose(1,0);g.next(1);g.dummies();
  assert.equal(g.v(0).players[1].role,'spy');
  g.choose(0,5);g.choose(1,5);g.next(0);g.next(1);g.dummies();
  g.choose(2,2);g.next(2);g.dummies();g.choose(4,0);g.next(4);g.dummies();g.choose(3,4);g.next(3);g.dummies();
  assert.equal(g.room.players[5].alive,false);
  assert.equal(g.v(4).threatened,true);
  g.host();g.room.vote(g.tokens[4],g.id(0));g.room.vote(g.tokens[6],g.id(0));
  assert.equal(g.v(0).voteResult,null);assert.equal(g.v(0).myVote,undefined);
  g.host();assert.equal(g.v(0).voteResult!.counts[g.id(0)],1);
  g.host();assert.equal(g.v(1).night!.status,'contacted');assert.equal(g.v(1).night!.canNext,true);g.dummies();
  g.room.hostSkipNightStep(g.tokens[0]);g.room.hostSkipNightStep(g.tokens[0]);
  assert.equal(g.v(4).night!.status,'blocked');assert.throws(()=>g.choose(4,0));g.dummies();
  // 깡패 사망: 깡패 차례는 그대로 보이지만 능력은 실행되지 않고, 사망자는 누르지 않는다
  g.room.players[3].alive=false;
  assert.equal(g.v(3).night!.status,'dead');
  assert.equal(g.v(3).night!.canNext,false);
  assert.equal(g.v(6).night!.step,'gangster');
  assert.equal(g.v(6).night!.status,'wait');
  assert.throws(()=>g.choose(3,6));assert.throws(()=>g.next(3));
  g.dummies();
  assert.equal(g.room.phase,'day','사망자를 기다리지 않고 넘어감');
  assert.equal(g.r.threatened.size,0,'죽은 깡패의 능력은 실행되지 않음');assert.equal(g.v(4).threatened,false);
  g.room.players[0].alive=false;assert.equal(g.r.checkWin(),false,'contacted spy counts');
  g.room.players[1].alive=false;assert.equal(g.r.checkWin(),true);
}
{
  const g=setup(['mafia','spy','citizen','citizen','citizen']);
  g.room.players[0].alive=false;assert.equal(g.r.checkWin(),true);assert.equal(g.room.winner,'citizen');
}
{
  const g=setup(['mafia','politician','police','citizen','citizen']);g.intro();g.host();
  g.room.vote(g.tokens[0],g.id(1));g.room.vote(g.tokens[2],g.id(1));
  g.host();assert.equal(g.v(0).voteResult!.reason,'notEnough');g.host();
  while(g.room.phase==='night')g.room.hostSkipNightStep(g.tokens[0]);
  g.host();for(const i of [0,2,3])g.room.vote(g.tokens[i],g.id(1));
  g.host();g.host();g.host();for(const i of [0,2,3,4])g.room.finalVote(g.tokens[i],true);
  assert.equal(g.room.phase,'final','all submitted still awaits host');g.host();
  assert.equal(g.room.players[1].alive,true,'politician immune');
}
// 300 complete games through public manual progression methods.
const results: Record<string,number>={};
for(let run=0;run<300;run++) {
  const g=setup(['mafia','spy','doctor','police','gangster','citizen','citizen','citizen']);g.intro();
  let guard=0;
  while(g.room.phase!=='ended' && guard++<1500) {
    if(g.room.phase==='night') {
      const active=g.tokens.map((t,i)=>({t,i,v:g.v(i)})).filter(x=>x.v.night!.status==='pick');
      const target=g.room.players.find(p=>p.alive && active.every(x=> {
        const n=x.v.night!;
        return n.step==='doctor' ? p.id!==n.blockedTarget : n.step==='mafia' ? !g.r.isMafiaSide(p) : p.role!==n.step;
      }));
      if(active.length && !target) {g.room.hostSkipNightStep(g.tokens[0]);continue;}
      for(const x of active)g.room.nightPick(x.t,target!.id);
      for(const x of active)g.room.nightNext(x.t);
      g.dummies();
      // 모든 생존자가 정확히 2번(선택+다음 또는 다음+다음) 눌러야 차례가 끝난다
    } else {
      if(g.room.phase==='vote') {
        const living=g.room.players.filter(p=>p.alive);
        const target=living[Math.floor(Math.random()*living.length)].id;
        for(const t of g.tokens)if(g.room.viewFor(t).canVote)g.room.vote(t,target);
      }
      if(g.room.phase==='final')for(const t of g.tokens)if(g.room.viewFor(t).canVote)g.room.finalVote(t,true);
      g.host();
    }
    for(const t of g.tokens) {
      const v=g.room.viewFor(t);
      assert.ok(!JSON.stringify(v).includes('token-'));
      assert.ok(v.log.every(l=>!('to' in l)));
      if(v.night?.status==='wait') assert.deepEqual(v.night.team,[]);
    }
  }
  assert.equal(g.room.phase,'ended');results[g.room.winner!]=(results[g.room.winner!]??0)+1;
}
console.log('✅ manual-flow rule tests and 300 simulations passed',results);
