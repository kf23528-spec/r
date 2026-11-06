// 将棋AIアリーナ - Express + Socket.IO server
// Node.js 18+ recommended. Install: npm install
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
function createShogiEngine(){
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const VALUE_HIDDEN=64,VALUE_INPUTS=12,VALUE_WEIGHTS=VALUE_INPUTS*VALUE_HIDDEN+VALUE_HIDDEN+VALUE_HIDDEN+1;
 const TYPES=['K','R','B','G','S','N','L','P'];
 const MAX_DROPS_PER_SIDE=5;
 const VALUES={K:0,R:1000,B:850,G:600,S:520,N:430,L:360,P:180};
 const PROMOTED={R:'D',B:'H',S:'G',N:'G',L:'G',P:'G'};
 const STEP_K=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
 function emptyHands(){return {1:{R:0,B:0,G:0,S:0,N:0,L:0,P:0},'-1':{R:0,B:0,G:0,S:0,N:0,L:0,P:0}};}
 function initialState(){
  const board=Array(81).fill(null),put=(x,y,s,t)=>board[y*9+x]={s,t,p:false};
  const back=['L','N','S','G','K','G','S','N','L'];
  for(let x=0;x<9;x++){put(x,0,-1,back[x]);put(x,8,1,back[x]);put(x,2,-1,'P');put(x,6,1,'P');}
  put(1,1,-1,'R');put(7,1,-1,'B');put(1,7,1,'B');put(7,7,1,'R');
  return {board,hands:emptyHands(),dropsUsed:{'1':0,'-1':0},turn:1,ply:0,history:[]};
 }
 function dropsUsedFor(st,side){const n=Number(st?.dropsUsed?.[String(side)]??0);return Number.isInteger(n)?clamp(n,0,MAX_DROPS_PER_SIDE):0;}
 function cloneState(st){return {board:st.board.map(p=>p?{s:p.s,t:p.t,p:!!p.p}:null),hands:{1:{...st.hands[1]},'-1':{...st.hands['-1']}},dropsUsed:{'1':dropsUsedFor(st,1),'-1':dropsUsedFor(st,-1)},turn:st.turn,ply:st.ply,history:(st.history||[]).slice()};}
 function inside(x,y){return x>=0&&x<9&&y>=0&&y<9;}
 function key(x,y){return y*9+x;}
 function demote(t){return t==='D'?'R':t==='H'?'B':t==='G'?'G':t;}
 function forward(side){return -side;}
 function promoteZone(side,y){return side===1?y<=2:y>=6;}
 function canPromote(p){return p&&!p.p&&!['K','G'].includes(p.t);}
 function mandatoryPromote(t,side,y){if(t==='P'||t==='L')return side===1?y===0:y===8;if(t==='N')return side===1?y<=1:y>=7;return false;}
 function rawTargets(st,from,p){
  const x=from%9,y=Math.floor(from/9),f=forward(p.s),out=[];
  const add=(dx,dy,slide=false)=>{let nx=x+dx,ny=y+dy;while(inside(nx,ny)){const q=st.board[key(nx,ny)];if(q&&q.s===p.s)break;out.push(key(nx,ny));if(q||!slide)break;nx+=dx;ny+=dy;}};
  const gold=p.p&&['S','N','L','P'].includes(p.t);
  if(p.t==='K')STEP_K.forEach(([dx,dy])=>add(dx,dy));
  else if(p.t==='R'||(p.p&&p.t==='R')){[[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>add(dx,dy,true));if(p.p)[[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dx,dy])=>add(dx,dy));}
  else if(p.t==='B'){[[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dx,dy])=>add(dx,dy,true));if(p.p)[[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>add(dx,dy));}
  else if(p.t==='L')add(0,f,true);
  else if(p.t==='N'){add(-1,2*f);add(1,2*f);}
  else if(p.t==='G'||gold){[[0,f],[1,f],[-1,f],[1,0],[-1,0],[0,-f]].forEach(([dx,dy])=>add(dx,dy));}
  else if(p.t==='S'){[[0,f],[1,f],[-1,f],[1,-f],[-1,-f]].forEach(([dx,dy])=>add(dx,dy));}
  else if(p.t==='P')add(0,f);
  return out;
 }
 function isSquareAttacked(st,target,bySide){
  for(let from=0;from<81;from++){const p=st.board[from];if(!p||p.s!==bySide)continue;if(rawTargets(st,from,p).includes(target))return true;}
  return false;
 }
 function inCheck(st,side){let k=-1;for(let i=0;i<81;i++){const p=st.board[i];if(p&&p.s===side&&p.t==='K'){k=i;break;}}if(k<0)return true;return isSquareAttacked(st,k,-side);}
 function applyMove(st,m){
  const n=cloneState(st),h=n.hands[String(m.s||st.turn)];
  if(m.drop){h[m.drop]=Math.max(0,(h[m.drop]||0)-1);n.dropsUsed[String(st.turn)]=Math.min(MAX_DROPS_PER_SIDE,(n.dropsUsed[String(st.turn)]||0)+1);n.board[m.to]={s:st.turn,t:m.drop,p:false};}
  else{const pc=n.board[m.from];const captured=n.board[m.to];if(captured){const ct=demote(captured.t);if(ct!=='K')h[ct]=(h[ct]||0)+1;}n.board[m.from]=null;n.board[m.to]={s:pc.s,t:pc.t,p:!!pc.p||!!m.promote};}
  n.turn=-st.turn;n.ply=st.ply+1;return n;
 }
 function hasAnyLegalMove(st,side=st.turn,pawnMateDepth=0){
  // A checking pawn drop consumes one hand pawn. The depth bound is therefore
  // safely above any real chain (there are only 18 pawns in the whole game).
  if(pawnMateDepth>18)return true;
  const base=st.turn===side?st:{...st,turn:side};
  for(let from=0;from<81;from++){
   const p=base.board[from];if(!p||p.s!==side)continue;
   for(const to of rawTargets(base,from,p)){
    if(base.board[to]?.t==='K')continue;
    const y=Math.floor(to/9),can=canPromote(p)&&(promoteZone(side,Math.floor(from/9))||promoteZone(side,y));
    const must=mandatoryPromote(p.t,side,y),variants=can?(must?[true]:[false,true]):[false];
    for(const promote of variants){const next=applyMove(base,{from,to,promote,s:side});if(!inCheck(next,side))return true;}
   }
  }
  const hand=base.hands[String(side)];
  if(dropsUsedFor(base,side)>=MAX_DROPS_PER_SIDE)return false;
  for(const t of TYPES.filter(x=>x!=='K')){
   if(!(hand[t]>0))continue;
   for(let to=0;to<81;to++){
    if(base.board[to])continue;
    const x=to%9,y=Math.floor(to/9);if(mandatoryPromote(t,side,y))continue;
    if(t==='P'){
     let nifu=false;for(let yy=0;yy<9;yy++){const q=base.board[key(x,yy)];if(q&&q.s===side&&q.t==='P'&&!q.p){nifu=true;break;}}
     if(nifu)continue;
    }
    const next=applyMove(base,{drop:t,to,s:side});
    if(inCheck(next,side))continue;
    // Only a pawn drop that gives check needs the recursive uchi-fuzume test.
    if(t==='P'&&inCheck(next,-side)&&!hasAnyLegalMove(next,-side,pawnMateDepth+1))continue;
    return true;
   }
  }
  return false;
 }
 function legalMoves(st,side=st.turn){
  const moves=[];
  const base=st.turn===side?st:{...st,turn:side};
  for(let from=0;from<81;from++){
   const p=base.board[from];if(!p||p.s!==side)continue;
   for(const to of rawTargets(base,from,p)){
    if(base.board[to]?.t==='K')continue;
    const y=Math.floor(to/9),can=canPromote(p)&&(promoteZone(side,Math.floor(from/9))||promoteZone(side,y));
    const must=mandatoryPromote(p.t,side,y);
    const variants=can?(must?[true]:[false,true]):[false];
    for(const promote of variants){const m={from,to,promote,s:side};const next=applyMove(base,m);if(!inCheck(next,side))moves.push(m);}
   }
  }
  const hand=base.hands[String(side)];
  if(dropsUsedFor(base,side)<MAX_DROPS_PER_SIDE)for(const t of TYPES.filter(x=>x!=='K')){if(!(hand[t]>0))continue;
   for(let to=0;to<81;to++){if(base.board[to])continue;const x=to%9,y=Math.floor(to/9);if(mandatoryPromote(t,side,y))continue;
    if(t==='P'){let nifu=false;for(let yy=0;yy<9;yy++){const q=base.board[key(x,yy)];if(q&&q.s===side&&q.t==='P'&&!q.p){nifu=true;break;}}if(nifu)continue;}
    const m={drop:t,to,s:side};const next=applyMove(base,m);if(!inCheck(next,side)){const pawnDropMate=t==='P'&&inCheck(next,-side)&&!hasAnyLegalMove(next,-side);if(!pawnDropMate)moves.push(m);}
   }
  }
  return moves;
 }
 function positionFeatures(st){
  let material=0,pawns=0,promoted=0,advance=0,center=0,camp=0,hand=0,pieces=0,majors=0,kingProgress=0,kingSafetyDiff=0;const kings={1:-1,'-1':-1},pieceBalance=0;
  for(let i=0;i<81;i++){const p=st.board[i];if(!p)continue;const sign=p.s===1?1:-1,x=i%9,y=Math.floor(i/9);if(p.t==='K'){kings[p.s]=i;continue;}pieces+=sign;let v=VALUES[p.t]||0;if(p.p){promoted+=sign;if(p.t==='R')v=1250;else if(p.t==='B')v=1120;else v=600;}material+=sign*v;if(p.t==='P')pawns+=sign;advance+=sign*(p.s===1?8-y:y);center+=sign*(4-Math.abs(4-x));if((p.s===1&&y<=2)||(p.s===-1&&y>=6))camp+=sign;if(p.t==='R'||p.t==='B')majors+=sign;}
  for(const side of [1,-1]){const h=st.hands[String(side)];for(const t of TYPES){if(t==='K')continue;hand+=(side===1?1:-1)*(VALUES[t]||0)*(h[t]||0);}}
  for(const side of [1,-1]){const k=kings[side];if(k>=0){const kx=k%9,ky=Math.floor(k/9);let friends=0,enemies=0;for(let y=Math.max(0,ky-2);y<=Math.min(8,ky+2);y++)for(let x=Math.max(0,kx-2);x<=Math.min(8,kx+2);x++){const q=st.board[key(x,y)];if(q&&q.s===side)friends++;else if(q&&q.s===-side)enemies++;}kingSafetyDiff+=(side===1?1:-1)*(friends-enemies);kingProgress+=(side===1?1:-1)*(side===1?ky:8-ky);}}
  return [1,clamp(material/5000,-1,1),clamp(pawns/18,-1,1),clamp(promoted/8,-1,1),clamp(advance/72,-1,1),clamp(center/36,-1,1),clamp(camp/12,-1,1),clamp(hand/3000,-1,1),clamp(kingSafetyDiff/12,-1,1),clamp(kingProgress/16,-1,1),clamp(majors/4,-1,1),clamp(pieces/36,-1,1)];
 }
 function evaluate(st,pov,weights={}){
  const w={material:weights.material??1,advance:weights.advance??.11,kingSafety:weights.kingSafety??.12,hand:weights.hand??.92,center:weights.center??.06};let score=0,king={1:-1,'-1':-1},safety={1:0,'-1':0};
  for(let i=0;i<81;i++){const p=st.board[i];if(!p)continue;if(p.t==='K'){king[p.s]=i;continue;}let v=VALUES[p.t]||0;if(p.p){if(p.t==='R')v=1250;else if(p.t==='B')v=1120;else v=600;}const y=Math.floor(i/9),x=i%9,adv=p.s===1?8-y:y;let ps=v*w.material+adv*w.advance*(p.t==='P'?2.1:1)+(4-Math.abs(4-x))*w.center;score+=p.s===pov?ps:-ps;}
  for(const side of [1,-1]){const h=st.hands[String(side)];for(const t of TYPES){if(t==='K')continue;const v=(VALUES[t]||0)*w.hand*(h[t]||0);score+=side===pov?v:-v;}}
  for(const side of [1,-1]){const k=king[side];if(k>=0){const kx=k%9,ky=Math.floor(k/9);let friends=0,enemies=0;for(let y=Math.max(0,ky-2);y<=Math.min(8,ky+2);y++)for(let x=Math.max(0,kx-2);x<=Math.min(8,kx+2);x++){const q=st.board[key(x,y)];if(q&&q.s===side)friends++;else if(q&&q.s===-side)enemies++;}safety[side]=(friends-enemies)*w.kingSafety;}}
  score+=safety[pov]-safety[-pov];const vw=weights.valueNet;if(Array.isArray(vw)&&vw.length===VALUE_WEIGHTS){const f=positionFeatures(st),h=new Array(VALUE_HIDDEN),b1=VALUE_INPUTS*VALUE_HIDDEN,wo=b1+VALUE_HIDDEN;for(let j=0;j<VALUE_HIDDEN;j++){let z=vw[b1+j]||0,base=j*VALUE_INPUTS;for(let i=0;i<VALUE_INPUTS;i++)z+=(Number(vw[base+i])||0)*f[i];h[j]=Math.tanh(clamp(z,-8,8));}let out=vw[wo+VALUE_HIDDEN]||0;for(let j=0;j<VALUE_HIDDEN;j++)out+=(Number(vw[wo+j])||0)*h[j];score+=(pov===1?1:-1)*Math.tanh(clamp(out,-8,8))*160;}return score;
 }
 function tacticalTags(st,m,next){const tags=[];const mover=st.turn,src=m.drop?null:st.board[m.from],captured=m.drop?null:st.board[m.to];if(captured)tags.push('capture');if(m.promote)tags.push('promotion');if(m.drop)tags.push('drop');if(inCheck(next,-mover))tags.push('check');if(src&&src.t==='K')tags.push('kingMove');const px=m.to%9,py=Math.floor(m.to/9),centerBefore=m.from==null?8:Math.abs(4-(m.from%9))+Math.abs(4-Math.floor(m.from/9)),centerAfter=Math.abs(4-px)+Math.abs(4-py);if(centerAfter<centerBefore)tags.push('center');if(src&&['R','B','S','N','L'].includes(src.t)&&st.ply<24&&Math.abs(Math.floor(m.from/9)-(mover===1?8:0))>=2)tags.push('development');const moved=next.board[m.to];if(moved){const threats=rawTargets(next,m.to,moved).filter(i=>next.board[i]&&next.board[i].s===-mover&&next.board[i].t!=='K'&&(VALUES[next.board[i].t]||0)>=430);if(threats.length>=2)tags.push('fork');}return tags;}
  function moveKey(m){return m.drop?`D${m.drop}@${m.to}`:`${m.from}-${m.to}${m.promote?'+':''}`;}
 function moveOrder(st,m,preferredKey='',nodes=null,plyFromRoot=0){
  const k=moveKey(m);let score=0;
  if(k===preferredKey)score+=10000000;
  const victim=st.board[m.to],attacker=m.drop?null:st.board[m.from];
  if(victim)score+=1000000+(VALUES[demote(victim.t)]||0)*16-(VALUES[attacker?.t]||0);
  if(m.promote)score+=700000+(VALUES[attacker?.t]||0)*.2;
  if(m.drop)score+=1200+(VALUES[m.drop]||0)*.04;
  if(attacker&&m.from!=null){const y0=Math.floor(m.from/9),y1=Math.floor(m.to/9);score+=(attacker.s===1?y0-y1:y1-y0)*3+(4-Math.abs(4-(m.to%9)))*1.5;}
  const ks=nodes?.killers?.[plyFromRoot];if(ks){if(ks[0]===k)score+=26000;else if(ks[1]===k)score+=18000;}
  return score;
 }
 function terminalScore(st,pov){return st.turn===pov?-100000+st.ply:100000-st.ply;}
 function quiescence(st,alpha,beta,pov,weights,nodes,qDepth=0){
  nodes.n++;if((nodes.n&63)===0&&nodes.deadline&&Date.now()>=nodes.deadline){nodes.stopped=true;return evaluate(st,pov,weights);}
  const maximizing=st.turn===pov,checked=inCheck(st,st.turn),stand=evaluate(st,pov,weights);
  if(qDepth>=5&&!checked)return stand;if(qDepth>=8)return stand;
  if(!checked){if(maximizing){if(stand>=beta)return beta;if(stand>alpha)alpha=stand;}else{if(stand<=alpha)return alpha;if(stand<beta)beta=stand;}}
  const legal=legalMoves(st,st.turn);if(!legal.length)return terminalScore(st,pov);
  let moves=[];
  if(checked)moves=legal;
  else{for(const m of legal)if((!m.drop&&st.board[m.to])||m.promote)moves.push(m);}
  if(!moves.length)return stand;
  moves.sort((a,b)=>moveOrder(st,b,'',nodes,5+qDepth)-moveOrder(st,a,'',nodes,5+qDepth));
  if(maximizing){let best=checked?-Infinity:stand;for(const m of moves){if(nodes.stopped)break;const v=quiescence(applyMove(st,m),alpha,beta,pov,weights,nodes,qDepth+1);if(v>best)best=v;if(v>alpha)alpha=v;if(beta<=alpha)break;}return best===-Infinity?stand:best;}
  let best=checked?Infinity:stand;for(const m of moves){if(nodes.stopped)break;const v=quiescence(applyMove(st,m),alpha,beta,pov,weights,nodes,qDepth+1);if(v<best)best=v;if(v<beta)beta=v;if(beta<=alpha)break;}return best===Infinity?stand:best;
 }
 function minimax(st,depth,alpha,beta,pov,weights,nodes,plyFromRoot=0){
  nodes.n++;if((nodes.n&63)===0&&nodes.deadline&&Date.now()>=nodes.deadline){nodes.stopped=true;return evaluate(st,pov,weights);}
  const keyText=positionKey(st),alphaOriginal=alpha,betaOriginal=beta,entry=nodes.tt?.get(keyText);
  if(entry&&entry.depth>=depth){nodes.ttHits=(nodes.ttHits||0)+1;if(entry.flag==='exact')return entry.score;if(entry.flag==='lower')alpha=Math.max(alpha,entry.score);else if(entry.flag==='upper')beta=Math.min(beta,entry.score);if(alpha>=beta)return entry.score;}
  if(depth<=0)return quiescence(st,alpha,beta,pov,weights,nodes,0);
  const moves=legalMoves(st,st.turn);if(!moves.length)return terminalScore(st,pov);
  const maximizing=st.turn===pov;let best=maximizing?-Infinity:Infinity,bestKey='';
  moves.sort((a,b)=>moveOrder(st,b,entry?.bestKey,nodes,plyFromRoot)-moveOrder(st,a,entry?.bestKey,nodes,plyFromRoot));
  for(const m of moves){if(nodes.stopped)break;const next=applyMove(st,m),v=minimax(next,depth-1,alpha,beta,pov,weights,nodes,plyFromRoot+1),mk=moveKey(m);if(maximizing){if(v>best){best=v;bestKey=mk;}if(best>alpha)alpha=best;}else{if(v<best){best=v;bestKey=mk;}if(best<beta)beta=best;}
   if(beta<=alpha){const quiet=!m.promote&&!m.drop&&!st.board[m.to];if(quiet){const arr=nodes.killers[plyFromRoot]||(nodes.killers[plyFromRoot]=[]);if(arr[0]!==mk){arr[1]=arr[0];arr[0]=mk;}}break;}
  }
  if(best===Infinity||best===-Infinity)best=evaluate(st,pov,weights);
  if(nodes.tt&&!nodes.stopped){const flag=best<=alphaOriginal?'upper':best>=betaOriginal?'lower':'exact';if(nodes.tt.size>36000)nodes.tt.clear();nodes.tt.set(keyText,{depth,score:best,flag,bestKey});}
  return best;
 }
 function searchRoot(st,rootMoves,side,weights={},depth=2,workerIndex=0,workerCount=1,deadline=0,searchContext=null){
  let best=null,bestScore=-Infinity,bestTags=[],nodes={n:0,deadline,stopped:false,tt:searchContext?.tt||new Map(),killers:searchContext?.killers||[],ttHits:0};
  const phase=st.ply<24?'opening':st.ply<70?'middlegame':'endgame',rootHint=searchContext?.rootMove||'';
  const indexed=rootMoves.map((m,i)=>({m,i})).sort((a,b)=>moveOrder(st,b.m,rootHint,nodes,0)-moveOrder(st,a.m,rootHint,nodes,0));
  for(const item of indexed){const i=item.i;if(i%workerCount!==workerIndex)continue;if(deadline&&Date.now()>=deadline){nodes.stopped=true;break;}const m=item.m,next=applyMove(st,m),tags=tacticalTags(st,m,next),bias=weights.tacticBias||{},patterns=weights.tacticalPatternBias||{};let bonus=0;
   for(const tag of tags)bonus+=Number(bias[tag]||0)+Number(patterns[phase+'|'+tag]||0)+Number((weights.counterTacticBias||{})[tag]||0);
   const counterSquares=weights.counterSquareBias||[];if(Number.isFinite(counterSquares[m.to]))bonus+=Math.max(-5,Math.min(18,Number(counterSquares[m.to])||0));
   const counterMoves=weights.counterMoveBias||{};bonus+=Math.max(-25,Math.min(55,Number(counterMoves[moveKey(m)])||0));const repeatPenalty=weights.repetitionPenalty||{};bonus-=Math.max(0,Math.min(260,Number(repeatPenalty[moveKey(m)])||0));if(weights.preferredMoveKey===moveKey(m))bonus+=Math.max(0,Math.min(70,Number(weights.openingBonus)||0));
   const rootAlpha=Number.isFinite(bestScore)?bestScore-bonus:-Infinity;
   let score=minimax(next,Math.max(0,depth-1),rootAlpha,Infinity,side,weights,nodes,1)+bonus;
   if(score>bestScore||(score===bestScore&&((i+st.ply+workerIndex)%3===0))){bestScore=score;best=m;bestTags=tags;}
   if(nodes.stopped)break;
  }
  if(searchContext){searchContext.tt=nodes.tt;searchContext.killers=nodes.killers;if(best)searchContext.rootMove=moveKey(best);}
  return {move:best,score:bestScore,nodes:nodes.n,ttHits:nodes.ttHits||0,stopped:nodes.stopped,depth,tags:bestTags};
 }
 function chooseMove(st,weights={},depth=2){const moves=legalMoves(st);if(!moves.length)return null;return searchRoot(st,moves,st.turn,weights,depth,0,1);}
 function positionKey(st){return st.board.map(p=>p?(p.s===1?'+':'-')+p.t+(p.p?'!':''):'..').join('')+'|'+JSON.stringify(st.hands)+'|'+st.turn+'|drops:'+dropsUsedFor(st,1)+','+dropsUsedFor(st,-1);}
 function isLegalMove(st,m){if(!m||!validateState(st))return false;if(m.s!=null&&m.s!==st.turn)return false;const k=moveKey(m);return legalMoves(st,st.turn).some(x=>moveKey(x)===k);}
 function dropLegalityReason(st,type,to,side=st.turn){
  if(!['R','B','G','S','N','L','P'].includes(type))return 'その種類の駒は打てません。';
  if(!Number.isInteger(to)||to<0||to>=81)return '盤面の外です。';
  const base=st.turn===side?st:{...st,turn:side};
  if(dropsUsedFor(base,side)>=MAX_DROPS_PER_SIDE)return 'この対局で持ち駒を盤上へ打てる上限の5回に達しています。';
  if(!(base.hands[String(side)]?.[type]>0))return 'その駒は持ち駒にありません。';
  if(base.board[to])return 'そのマスには既に駒があります。';
  const y=Math.floor(to/9),x=to%9;
  if(mandatoryPromote(type,side,y))return type==='N'?'桂馬は最後の2段には打てません。':'歩・香車は最後の段には打てません。';
  if(type==='P'){for(let yy=0;yy<9;yy++){const q=base.board[key(x,yy)];if(q&&q.s===side&&q.t==='P'&&!q.p)return '二歩になるため、この筋には歩を打てません。';}}
  const next=applyMove(base,{drop:type,to,s:side});
  if(inCheck(next,side))return '自分の玉への王手を解消できないため、ここには打てません。王手駒を取るか、王手の線を遮る場所を選んでください。';
  if(type==='P'&&inCheck(next,-side)&&!hasAnyLegalMove(next,-side))return '打ち歩詰めになるため禁止です。';
  return '';
 }
 function validateState(st){
  if(!st||!Array.isArray(st.board)||st.board.length!==81||![1,-1].includes(st.turn)||!st.hands||!st.hands['1']||!st.hands['-1'])return false;
  const counts={K:0,R:0,B:0,G:0,S:0,N:0,L:0,P:0},max={K:2,R:2,B:2,G:4,S:4,N:4,L:4,P:18};
  const pawns={1:new Set(),'-1':new Set()};
  for(let i=0;i<81;i++){
   const p=st.board[i];if(!p)continue;
   if(![1,-1].includes(p.s)||!['K','R','B','G','S','N','L','P'].includes(p.t))return false;
   if(p.p&&!['R','B','S','N','L','P'].includes(p.t))return false;
   counts[p.t]++;
   const x=i%9,y=Math.floor(i/9);
   if(!p.p&&p.t==='P'){if(y===(p.s===1?0:8)||pawns[p.s].has(x))return false;pawns[p.s].add(x);}
   if(!p.p&&p.t==='L'&&y===(p.s===1?0:8))return false;
   if(!p.p&&p.t==='N'&&(p.s===1?y<=1:y>=7))return false;
  }
  for(const side of [1,-1]){const used=Number(st.dropsUsed?.[String(side)]??0);if(!Number.isInteger(used)||used<0||used>MAX_DROPS_PER_SIDE)return false;for(const t of ['R','B','G','S','N','L','P']){const n=Number(st.hands[String(side)][t]??0);if(!Number.isInteger(n)||n<0)return false;counts[t]+=n;}}
  for(const t of Object.keys(max))if(counts[t]!==max[t])return false;
  const kings={1:0,'-1':0};for(const p of st.board)if(p?.t==='K')kings[p.s]++;
  if(kings[1]!==1||kings[-1]!==1||inCheck(st,-st.turn))return false;
  return true;
 }
 function kingSquare(st,side){for(let i=0;i<81;i++){const p=st.board[i];if(p&&p.s===side&&p.t==='K')return i;}return -1;}
 function isInEnemyCamp(side,y){return side===1?y<=2:y>=6;}
 function isKingEntered(st,side){const k=kingSquare(st,side);return k>=0&&isInEnemyCamp(side,Math.floor(k/9));}
 function pointsFor(st,side,scope='all'){
  let points=0,campPieces=0;
  for(let i=0;i<81;i++){const p=st.board[i];if(!p||p.s!==side||p.t==='K')continue;const inCamp=isInEnemyCamp(side,Math.floor(i/9));if(scope==='camp'&&!inCamp)continue;if(scope==='camp')campPieces++;points+=(p.t==='R'||p.t==='B')?5:1;}
  const hand=st.hands[String(side)]||{};
  for(const t of ['R','B','G','S','N','L','P'])points+=(Number(hand[t])||0)*((t==='R'||t==='B')?5:1);
  return {points,campPieces};
 }
 function declarationStatus(st,side){
  const king=kingSquare(st,side),entered=king>=0&&isInEnemyCamp(side,Math.floor(king/9)),sc=pointsFor(st,side,'camp'),checked=king<0||inCheck(st,side),before500=(Number(st.ply)||0)<500,sideToMove=st.turn===side;
  const eligible=sideToMove&&entered&&sc.campPieces>=10&&!checked&&sc.points>=24&&before500;
  const resultPoints=sc.points>=31?'勝ち':sc.points>=24?'無勝負':'宣言不可（24点未満）';
  return {side,entered,campPieces:sc.campPieces,points:sc.points,checked,before500,sideToMove,eligible,resultPoints,reason:!before500?'500手到達後は入玉宣言不可':!sideToMove?'宣言側の手番ではない':!entered?'玉が敵陣3段目以内にいない':sc.campPieces<10?'敵陣3段目以内の駒が10枚未満':checked?'玉に王手がかかっている':sc.points<24?'宣言に必要な24点未満':sc.points<31?'条件成立：24～30点は無勝負':'条件成立：31点以上で勝ち'};
 }
 function impassePoints(st){return {sente:pointsFor(st,1,'all').points,gote:pointsFor(st,-1,'all').points};}
 function mutualImpasseOutcome(st){const p=impassePoints(st);if(p.sente<24)return {winner:-1,points:p,reason:'先手が24点未満'};if(p.gote<24)return {winner:1,points:p,reason:'後手が24点未満'};return {winner:0,points:p,reason:'双方24点以上・無勝負'};}
  function moveText(st,m){const files='９８７６５４３２１',ranks='一二三四五六七八九';const pos=`${files[m.to%9]}${ranks[Math.floor(m.to/9)]}`;if(m.drop)return `${pos}${({R:'飛',B:'角',G:'金',S:'銀',N:'桂',L:'香',P:'歩'})[m.drop]}打`;const p=st.board[m.from],piece=p.t==='K'?(p.s===-1?'王':'玉'):({R:'飛',B:'角',G:'金',S:'銀',N:'桂',L:'香',P:'歩'})[p.t];return `${pos}${piece}${m.promote?'成':''}`;}
 return {MAX_DROPS_PER_SIDE,dropsUsedFor,initialState,cloneState,legalMoves,hasAnyLegalMove,applyMove,inCheck,evaluate,positionFeatures,searchRoot,chooseMove,positionKey,moveText,moveKey,tacticalTags,demote,isLegalMove,dropLegalityReason,validateState,kingSquare,isKingEntered,pointsFor,impassePoints,declarationStatus,mutualImpasseOutcome};
}
const engine = createShogiEngine();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });
const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const rooms = new Map();
const cleanCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
function makeCode() { let code; do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code)); return code; }
function cleanToken(v) { return String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64); }
function publicRoom(room) { return { roomId: room.id, state: room.state, moves: room.moves, lastMove: room.lastMove || null, players: { sente: !!room.players[1], gote: !!room.players[-1] }, agents: room.agentNames || { '1': 'SENTE AI', '-1': 'GOTE AI' }, result: room.result, revision: room.revision }; }
function sendRoom(room) { io.to(room.id).emit('room-state', publicRoom(room)); }
function makeRoom(id) { return { id, state: engine.initialState(), players: { 1: null, '-1': null }, agentNames: { '1': 'SENTE AI', '-1': 'GOTE AI' }, tokens: { '1': null, '-1': null }, spectators: new Set(), moves: [], lastMove: null, result: null, revision: 0, positions: new Map([[engine.positionKey(engine.initialState()), 1]]), createdAt: Date.now(), lastActive: Date.now() }; }
function resultFor(room) { const legal = engine.legalMoves(room.state); if (!legal.length) { room.result = { winner: engine.inCheck(room.state, room.state.turn) ? -room.state.turn : 0, reason: engine.inCheck(room.state, room.state.turn) ? 'checkmate' : 'no-legal-moves' }; } else if (room.state.ply >= 500) { room.result = { winner: 0, reason: 'move-limit' }; } else { const key = engine.positionKey(room.state); const count = (room.positions.get(key) || 0) + 1; room.positions.set(key, count); if (count >= 4) room.result = { winner: 0, reason: 'repetition' }; } }
io.on('connection', socket => {
 socket.on('create-room', payload => { const id = makeCode(), room = makeRoom(id), token = cleanToken(payload?.token) || crypto.randomBytes(18).toString('hex'); room.players[1] = socket.id; room.tokens['1'] = token; rooms.set(id, room); socket.join(id); socket.data.roomId = id; socket.data.side = 1; socket.data.token = token; socket.emit('room-created', { ...publicRoom(room), side: 1 }); });
 socket.on('join-room', payload => { const id = cleanCode(payload?.roomId), room = rooms.get(id), token = cleanToken(payload?.token) || crypto.randomBytes(18).toString('hex'); if (!room) return socket.emit('room-error', { message: 'そのルームは見つかりません。コードを確認してください。' }); if (room.result) return socket.emit('room-error', { message: 'この対局は終了しています。新しい部屋を作成してください。' }); let side = [1, -1].find(s => token && room.tokens[String(s)] === token && !room.players[s]); if (!side) side = !room.players[-1] && !room.tokens['-1'] ? -1 : (!room.players[1] && !room.tokens['1'] ? 1 : 0); if (side === 0) { room.spectators.add(socket.id); socket.join(id); socket.data.roomId = id; socket.data.side = 0; socket.data.token = token; socket.emit('room-joined', { ...publicRoom(room), side: 0 }); return; } room.players[side] = socket.id; room.tokens[String(side)] = token; socket.join(id); socket.data.roomId = id; socket.data.side = side; socket.data.token = token; room.lastActive = Date.now(); socket.emit('room-joined', { ...publicRoom(room), side }); sendRoom(room); });
 socket.on('agent-profile', payload => { const id = cleanCode(payload?.roomId), room = rooms.get(id), side = socket.data.side; if (!room || socket.data.roomId !== id || ![1, -1].includes(side) || room.players[side] !== socket.id) return; const name = String(payload?.name || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 22); if (name) room.agentNames[String(side)] = name; sendRoom(room); });
 socket.on('rejoin-room', payload => { const id = cleanCode(payload?.roomId), room = rooms.get(id), token = cleanToken(payload?.token); if (!room) return socket.emit('room-error', { message: '再接続先のルームがありません。' }); const side = [1, -1].find(s => token && room.tokens[String(s)] === token && !room.players[s]); if (!side) return socket.emit('room-error', { message: 'この端末の再接続情報が確認できません。ルームコードから再参加してください。' }); room.players[side] = socket.id; socket.join(id); socket.data.roomId = id; socket.data.side = side; socket.data.token = token; socket.emit('room-joined', { ...publicRoom(room), side }); sendRoom(room); });
 socket.on('move', payload => { const id = cleanCode(payload?.roomId), room = rooms.get(id), side = socket.data.side, move = payload?.move; if (!room || socket.data.roomId !== id || ![1, -1].includes(side)) return socket.emit('room-error', { message: 'この部屋の対局者ではありません。' }); if (room.result) return socket.emit('room-error', { message: '対局は既に終了しています。' }); if (room.players[side] !== socket.id || room.state.turn !== side) return socket.emit('room-error', { message: '現在はあなたの手番ではありません。' }); if (payload?.expectedRevision != null && Number(payload.expectedRevision) !== room.revision) { socket.emit('room-state', publicRoom(room)); return socket.emit('room-error', { message: '盤面が更新されました。最新状態を読み直します。' }); } if (!engine.isLegalMove(room.state, move)) return socket.emit('room-error', { message: '不正な着手です。盤面を更新してください。' }); const before = room.state; room.lastMove = move; room.state = engine.applyMove(before, move); room.moves.push((side === 1 ? '▲' : '△') + engine.moveText(before, move)); room.revision++; room.lastActive = Date.now(); resultFor(room); sendRoom(room); });
 socket.on('resign', payload => { const id = cleanCode(payload?.roomId), room = rooms.get(id), side = socket.data.side; if (!room || room.players[side] !== socket.id || ![1, -1].includes(side) || room.result) return; room.result = { winner: -side, reason: 'resign' }; sendRoom(room); });
 socket.on('leave-room', payload => { const id = cleanCode(payload?.roomId), room = rooms.get(id); if (room) { const side = socket.data.side; if (room.players[side] === socket.id) { room.players[side] = null; if (side === 1 || side === -1) room.tokens[String(side)] = null; } room.spectators.delete(socket.id); room.lastActive = Date.now(); sendRoom(room); } socket.leave(id); socket.data.roomId = null; socket.data.side = 0; socket.data.token = null; });
 socket.on('disconnect', () => { const id = socket.data.roomId, room = rooms.get(id); if (room) { const side = socket.data.side; if (room.players[side] === socket.id) room.players[side] = null; room.spectators.delete(socket.id); room.lastActive = Date.now(); sendRoom(room); } });
});
setInterval(() => { const now = Date.now(); for (const [id, room] of rooms) if (now - room.lastActive > 6 * 60 * 60 * 1000) rooms.delete(id); }, 10 * 60 * 1000).unref();
server.listen(PORT, '0.0.0.0', () => console.log(`Shogi AI Arena listening on ${PORT}`));
