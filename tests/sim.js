const vm=require('vm'),fs=require('fs');
const BASE='http://localhost:3999/';
let src=fs.readFileSync(process.argv[2],'utf8');
const _st=src.indexOf('<script>\n')+9; src=src.slice(_st,src.indexOf('</script>',_st));
const HANDLIB=fs.readFileSync(require('path').join(require('path').dirname(process.argv[2]),'hand.js'),'utf8');
const QRLIB=fs.readFileSync(require('path').join(require('path').dirname(process.argv[2]),'qrcode.js'),'utf8');
const hook=`globalThis.__kr={S:function(){return S;},main:main,hand:hand,phase:phase,stage:stage,parts:parts,chipOf:chipOf,
 takeChip:takeChip,toggleReady:toggleReady,startHand:startHand,setGuessCard:setGuessCard,confirmGuess:confirmGuess,
 revealMine:revealMine,createRoom:createRoom,joinRoom:joinRoom,watchRoom:watchRoom,playNow:playNow,guessers:guessers,
 canGuess:canGuess,revealedCards:revealedCards,uid:function(){return uid;},code:function(){return code;},
 watching:function(){return watching;},myHand:function(){return myHand;},sendChat:sendChat,kickPlayer:kickPlayer,
 takeOver:takeOver,leave:leave,cd:function(){return cd;},online:function(){return online;},err:function(){return uiErr;},
 isOnline:isOnline,pmap:pmap,myPub:function(){return myPubJwk;},closeRoom:closeRoom,isHost:isHost,bestHand:bestHand,handName:handName,cmpHand:cmpHand,
 resolveHand:resolveHand,guessResult:guessResult,visibleBoard:visibleBoard,HAND_EX:HAND_EX,HAND_NAMES:HAND_NAMES,
 jumpIn:jumpIn,sendReact:sendReact,lastFx:function(){return lastFx;},inviteUrl:inviteUrl,renameRoom:renameRoom,calcStats:calcStats,statsOpen:function(){statsOpen=true;render();},roomName:roomName,planRoom:planRoom,planned:function(){return planned;},inviteInfo:function(){return inviteInfo;},note:function(){return uiNote;},nudge:nudge,toggleFx:toggleFx,
 openInvite:function(){inviteOpen=true;render();},inviteCode:function(){return inviteCode;}};\n`;
const i=src.lastIndexOf('})();'); src=src.slice(0,i)+hook+src.slice(i);
function client(name,ls,opts){
  ls=ls||{};opts=opts||{};
  const els={name:{value:name},code:{value:''},app:{innerHTML:'',className:''},roomlist:{innerHTML:''},playcount:{innerHTML:''},
    chat:{innerHTML:'',style:{}},chatmsgs:{innerHTML:'',scrollTop:0,scrollHeight:0},chatin:{value:''},
    toast:{textContent:'',className:'',log:[]}};
  Object.defineProperty(els.toast,'textContent',{get(){return this._t||'';},set(v){this._t=v;this.log.push(v);}});
  const ctx={console,setTimeout,clearTimeout,setInterval,clearInterval,TextEncoder,TextDecoder,btoa,atob,crypto:globalThis.crypto,
    fetch:(u,o)=>fetch(BASE+u,o),location:{pathname:'/',search:'',hash:opts.hash||'',origin:'http://localhost:3999',protocol:'http:',host:'localhost:3999'},navigator:{},history:{replaceState(){}},
    localStorage:{getItem:k=>k in ls?ls[k]:null,setItem:(k,v)=>ls[k]=String(v),removeItem:k=>delete ls[k]},
    document:{getElementById:id=>((id==='chatmsgs'||id==='chatin')&&!els.chat.innerHTML.includes('id="'+id+'"'))?null:(els[id]||null),addEventListener(){},hidden:false,documentElement:{setAttribute(){},getAttribute(){return null;}}}};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(HANDLIB,ctx);vm.runInContext(QRLIB+';this.qrcode=qrcode;',ctx);vm.runInContext(src,ctx);ctx.els=els;ctx.ls=ls;return ctx;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,what,ms=20000){const t=Date.now();while(Date.now()-t<ms){try{if(f())return;}catch(e){}await sleep(100);}throw new Error('Timeout: '+what);}
const ok=(c,m)=>{if(!c)throw new Error('FEHLER: '+m);console.log('  ok  '+m);};
const txt=h=>h.replace(/<[^>]+>/g,' ');
/* Chips nach echter Stärke (schwächste = 1); rev=true dreht um */
function strengthPlan(P,rev){
  const X=P[0].__kr, board=X.visibleBoard();
  const hs=P.map((x,k)=>({k,h:X.bestHand(x.__kr.myHand().cards.concat(board),x.__kr.myHand().cards)}));
  hs.sort((a,b)=>X.cmpHand(a.h,b.h)); if(rev)hs.reverse();
  const plan=[]; hs.forEach((e,i)=>plan[e.k]=i+1); return plan;
}
/* Unabhängige Erwartung: gewonnen, wenn kein Paar mit Chip-Reihenfolge gegen die Stärke */
function expectWin(X,ids){
  const board=X.visibleBoard(), h4=X.main().chipHist['4'];
  const L=ids.map(id=>({id,chip:h4[id],h:X.bestHand(X.revealedCards(id).concat(board),X.revealedCards(id))}));
  const bad=new Set();
  for(const a of L)for(const b of L)if(a.chip<b.chip&&X.cmpHand(a.h,b.h)>0){bad.add(a.id);bad.add(b.id);}
  return {win:bad.size===0,bad};
}
const faces=h=>(h.replace(/<details class="ranking">[^]*?<\/details>/g,'').match(/class="r"/g)||[]).length;   // sichtbare Spielkarten (ohne Beispielkarten der Rangfolge)
const toasts=X=>X.els.toast.log.join(' | ');
const post=(a,code,body,key)=>fetch(BASE+'api?a='+a+'&room='+code,{method:'POST',
  headers:{'Content-Type':'application/json','x-kr-key':key||'fremder-schluessel-1234567890'},body:JSON.stringify(body)});
(async()=>{
  const A=client('Anna'),B=client('Ben'),C=client('Cem'),D=client('Dora');
  await sleep(500);
  // Handbewertung
  const cd=s=>'23456789TJQKA'.indexOf(s[0])+13*'shdc'.indexOf(s[1]);
  const H=a=>A.__kr.bestHand(a.map(cd)), N=a=>A.__kr.handName(H(a));
  const cases=[
    [['As','Ks','Qs','Js','Ts'],'Royal Flush'],
    [['9h','8h','7h','6h','5h'],'Straight Flush bis 9'],
    [['Ah','2d','3c','4s','5h'],'Straße bis 5'],
    [['Kh','Kd','Ks','2c','2d'],'Full House: Könige und Zweien'],
    [['Ah','2d','Kh','Qh','Jh','Th','3c'],'Royal Flush'],
    [['2h','2d','3c','3s','Ah','Ad','Kc'],'Zwei Paare: Asse und Dreien'],
    [['Kh','Kd'],'Ein Paar: Könige'],
    [['7c','2d'],'Höchste Karte: 7'],
    [['7c','7d','7h','7s','2d','9c'],'Vierling: Siebenen'],
    [['2h','9h','4h','Jh','6h','Kc','Kd'],'Flush, Bube hoch'],
    [['Tc','Jd','Qh','Ks','Ah'],'Straße bis Ass'],
    [['Ah','9d','7c','4s','2h'],'Höchste Karte: Ass'],
    [['Kh','Ad','2c','3s','4h'],'Höchste Karte: Ass'],       // K-A-2-3-4 ist keine Straße
    [['Ah','Kh'],'Höchste Karte: Ass'],
  ];
  for(const [cs,name] of cases){ const got=N(cs); ok(got===name,'Hand '+cs.join(' ')+' → '+got); }
  const cmp=(a,b)=>A.__kr.cmpHand(H(a),H(b));
  ok(cmp(['2h','2d','5c','7s','9h'],['Ah','Kd','5c','7s','9h'])>0,'Paar Zweien schlägt Ass-hoch');
  ok(cmp(['2h','2d','Ac','7s','9h'],['2s','2c','Kc','7d','9d'])>0,'Gleiches Paar: höhere Beikarte gewinnt');
  ok(cmp(['2h','9h','4h','Jh','6h'],['9c','8d','7h','6s','5h'])>0,'Flush schlägt Straße');
  ok(cmp(['Ah','2d','3c','4s','5h'],['2c','3d','4h','5s','6h'])<0,'A-2-3-4-5 ist die kleinste Straße');
  ok(cmp(['Tc','Jd','Qh','Ks','Ah'],['9c','Td','Jh','Qs','Kh'])>0,'10-B-D-K-A ist die höchste Straße');
  ok(cmp(['Ah','3d','5c','7s','9h'],['Kh','Qd','Jc','9s','8h'])>0,'Ass ist die höchste Einzelkarte');
  A.__kr.HAND_EX.forEach((ex,i)=>{
    const h=H(ex.map(s=>s.replace('-','')));
    ok(h.cat===i,'Rangfolge-Beispiel „'+A.__kr.HAND_NAMES[i]+'“ ist wirklich '+A.__kr.handName(h));
  });
  // Hausregel: Höchste Karte nur aus eigenen Handkarten
  const HH=(hole,board)=>A.__kr.bestHand(hole.concat(board).map(cd),hole.map(cd));
  const tbl=['Ah','Kd','9s','5h','3c'];
  ok(A.__kr.handName(HH(['7c','2d'],tbl))==='Höchste Karte: 7','Höchste Karte zählt nur eigene Karten (7-2, Ass auf dem Tisch → 7)');
  ok(A.__kr.handName(HH(['7c','9d'],tbl))==='Ein Paar: Neunen','Paar mit dem Tisch zählt weiterhin');
  const tbl2=['Ah','Kd','Qs','Jh','9c'];
  ok(A.__kr.cmpHand(HH(['4c','2d'],tbl2),HH(['3s','2h'],tbl2))>0,'Nur höchste Karte: 4-2 schlägt 3-2 (normal wäre Gleichstand über den Tisch)');
  ok(A.__kr.cmpHand(HH(['8c','2d'],tbl),HH(['8s','3h'],tbl))<0,'Gleiche höchste Karte → zweite eigene Karte entscheidet');
  // Hausregel: Kombination zählt nur, wenn die eigenen Karten sie verbessern (Screenshot 2026-09-23, Tisch K♦ B♦ 4♦ 6♦ B♥)
  const tbl3=['Kd','Jd','4d','6d','Jh'], HN=(h,b)=>A.__kr.handName(HH(h,b));
  ok(HN(['Ah','8h'],tbl3)==='Höchste Karte: Ass'&&HN(['9s','Ac'],tbl3)==='Höchste Karte: Ass','Nur Tisch-Paar → Höchste Karte aus der Hand (Max A-8, Nina 9-A)');
  ok(A.__kr.cmpHand(HH(['9s','Ac'],tbl3),HH(['Ah','8h'],tbl3))>0,'Nina (A-9) vor Max (A-8)');
  ok(HN(['Kc','6h'],tbl3)==='Zwei Paare: Könige und Buben'&&HN(['Qh','Qs'],tbl3)==='Zwei Paare: Damen und Buben','Eigenes Paar + Tisch-Paar → zwei Paare (Tom, Paul)');
  ok(HN(['Jc','Td'],tbl3)==='Flush, 10 hoch'&&HN(['7d','5c'],tbl3)==='Flush, 7 hoch'&&A.__kr.cmpHand(HH(['Jc','Td'],tbl3),HH(['7d','5c'],tbl3))>0,'Flush: eigene höchste Flush-Karte zählt und wird angezeigt (10 hoch vor 7 hoch)');
  const fl=['2h','5h','7h','9h','Jh'];
  ok(HN(['As','Kc'],fl)==='Höchste Karte: Ass'&&HN(['Qh','3c'],fl)==='Flush, Dame hoch','Flush nur auf dem Tisch zählt nicht, eigene höhere Herz-Karte schon');
  ok(HN(['Qd','2d'],['Ad','Kd','3d','9c','8s'])==='Flush, Dame hoch'&&A.__kr.cmpHand(HH(['Qd','2d'],['Ad','Kd','3d','9c','8s']),HH(['Jd','Td'],['Ad','Kd','3d','9c','8s']))>0,'Flush mit zwei eigenen Karten: höchste eigene (Dame vor Bube)');
  ok(A.__kr.handName(A.__kr.bestHand(['2h','9h','4h','Jh','6h'].map(cd)))==='Flush, Bube hoch','Ohne Handkarten (Beispiele) bleibt die übliche Anzeige');
  const st5=['5c','6d','7h','8s','9c'];
  ok(HN(['2c','3d'],st5)==='Höchste Karte: 3'&&/^Straße/.test(HN(['Tc','3d'],st5)),'Straße nur auf dem Tisch zählt nicht, höhere Straße mit eigener Karte schon');
  ok(HN(['Kc','Ks'],['Jd','Jh','4c','4s','2d'])==='Zwei Paare: Könige und Buben','Eigenes höheres Paar schlägt Tisch-Zwei-Paare');
  const st4=['9d','Th','Jc','Qs','3h'];
  ok(HN(['8c','2d'],st4)==='Straße, 8 hoch'&&HN(['Kc','2d'],st4)==='Straße, König hoch'&&HN(['Kc','8d'],st4)==='Straße, König hoch','Straße heißt nach der eigenen höchsten Karte darin (8 hoch, König hoch)');
  ok(A.__kr.cmpHand(HH(['Kc','2d'],st4),HH(['8c','2d'],st4))>0,'Straße: Wertung weiter nach der obersten Karte (bis König vor bis Dame)');
  ok(HN(['Ac','Kd'],['2c','3d','4h','5s','9c'])==='Straße mit Ass als 1'&&HN(['Ac','3s'],['2c','Kd','4h','5s','9c'])==='Straße, 3 hoch','Ass als 1 in der kleinsten Straße');
  ok(A.__kr.handName(A.__kr.bestHand(['Ah','2d','3c','4s','5h'].map(cd)))==='Straße bis 5','Ohne Handkarten: „Straße bis …“ wie bisher');
  ok(HN(['7c','2d'],tbl)==='Höchste Karte: 7'&&HN(['7c','9d'],tbl)==='Ein Paar: Neunen','Bisherige Regeln unverändert');
  ok(txt(A.els.app.innerHTML).includes('Letzte Runde')&&!A.els.app.innerHTML.includes('Voice-Chat'),'Name „Letzte Runde“, Untertitel entfernt');
  A.__kr.createRoom(); await until(()=>A.__kr.code()&&A.__kr.S().players.length===1,'A im Raum');
  const code=A.__kr.code();
  ok(/class="brand sm" data-a="reload"/.test(A.els.app.innerHTML),'Raum: Logo lädt die Seite neu');
  B.__kr.joinRoom(code); C.__kr.joinRoom(code);
  await until(()=>A.__kr.S().players.length===3,'3 Spieler');
  await sleep(5500); ok(D.els.roomlist.innerHTML.includes(code),'Raumliste auf Startseite zeigt '+code);
  // Raumname: nur der Host, bereinigt, überall sichtbar
  A.__kr.renameRoom('  Freitags<b>runde</b>\u0007 '); await until(()=>B.__kr.roomName()==='Freitagsbrunde/b','B sieht Raumnamen');
  ok(A.els.app.innerHTML.includes('Freitagsbrunde/b')&&!A.els.app.innerHTML.includes('<b>runde'),'Raumname bereinigt im Kopf (keine Tags)');
  ok(A.els.app.innerHTML.includes('data-a="rename"')&&!B.els.app.innerHTML.includes('data-a="rename"'),'Umbenennen-Knopf nur beim Host');
  let r0=await post('rename',code,{uid:B.__kr.uid(),name:'Übernahme'},B.ls['kr.sk']);
  ok(r0.status===403,'Mitspieler darf nicht umbenennen');
  r0=await post('set',code+'&path=room',{code,hostId:B.__kr.uid(),name:'x'},B.ls['kr.sk']);
  ok(r0.status===403,'room-Dokument bleibt gesperrt');
  A.__kr.renameRoom('x'.repeat(80)); await until(()=>B.__kr.roomName()==='x'.repeat(30),'Name auf 30 Zeichen gekürzt'); ok(true,'Raumname max. 30 Zeichen');
  A.__kr.renameRoom('Freitagsrunde'); await until(()=>B.__kr.roomName()==='Freitagsrunde','Name gesetzt');
  await sleep(3100); const rl1=await (await fetch(BASE+'api?a=rooms')).json();
  ok(rl1.rooms.some(x=>x.code===code&&x.name==='Freitagsrunde'),'Raumliste liefert Raumnamen');
  await sleep(5200); ok(D.els.roomlist.innerHTML.includes('Freitagsrunde'),'Startseite zeigt Raumnamen');
  D.__kr.watchRoom(code); await until(()=>D.__kr.S().players.length===3,'D sieht Raum');
  ok(D.__kr.watching()&&D.els.app.innerHTML.includes('Zuschauer'),'D ist Zuschauer');
  // Chat
  A.__kr.sendChat('Hallo Runde'); await until(()=>B.__kr.S().chat.some(m=>m.text==='Hallo Runde'),'Chat bei B');
  await until(()=>B.__kr.lastFx()==='chat','Ton bei B',5000);
  // Schnelle Reaktionen
  ok(/data-react="4"/.test(A.els.app.innerHTML)&&!/data-react=/.test(D.els.app.innerHTML),'Reaktionsleiste für Spieler, nicht für Zuschauer');
  A.__kr.sendReact(4); await until(()=>/class="react-pop"[^>]*>🔥/.test(B.els.app.innerHTML),'🔥 bei Ben',6000);
  ok(true,'Reaktion 🔥 erscheint bei den anderen');
  { let rr=await post('react',code,{uid:A.__kr.uid(),e:1},A.ls['kr.sk']); ok(rr.status===429,'Reaktionen gebremst (höchstens alle 1,5 s)');
    rr=await post('react',code,{uid:D.__kr.uid(),e:1},D.ls['kr.sk']); ok(rr.status===403,'Zuschauer können nicht reagieren');
    await sleep(1600); rr=await post('react',code,{uid:A.__kr.uid(),e:9},A.ls['kr.sk']); ok(rr.status===400,'Nur die 5 festen Emojis'); } ok(A.__kr.lastFx()!=='chat','Chat-Ton beim Empfänger, nicht beim Absender');
  ok(B.els.chat.innerHTML.includes('id="chatin"'),'Spieler können schreiben');
  await until(()=>D.els.chatmsgs.innerHTML.includes('Hallo Runde'),'Zuschauer liest Chat');
  ok(D.els.chat.style.display===''&&!D.els.chat.innerHTML.includes('id="chatin"'),'Zuschauer liest Chat mit, ohne Eingabefeld');
  let r=await fetch(BASE+'api?a=chat&room='+code,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:D.__kr.uid(),text:'x'})});
  ok(r.status===403,'Server lehnt Chat von Zuschauer ab');
  r=await fetch(BASE+'api?a=set&room='+code+'&path=chat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"msgs":[]}'});
  ok(r.status===403,'Chat nicht direkt überschreibbar');
  await until(()=>A.__kr.online()&&A.__kr.online().length>=4,'Anwesenheit bekannt');
  r=await post('kick',code,{uid:B.__kr.uid(),target:C.__kr.uid()},B.ls['kr.sk']);
  ok(r.status===403,'Nicht-Host kann nicht kicken');
  r=await post('kick',code,{uid:A.__kr.uid(),target:C.__kr.uid()});
  ok(r.status===403,'Host-ID ohne passenden Geräteschlüssel kann nicht kicken');
  r=await fetch(BASE+'api?a=del&room='+code+'&path=players/'+C.__kr.uid(),{headers:{'x-kr-key':B.ls['kr.sk']}});
  ok(r.status===403,'Spieler-Eintrag nicht direkt löschbar');
  r=await post('set',code+'&path=players/'+A.__kr.uid(),{name:'Fake'});
  ok(r.status===403,'Fremder Online-Spielerplatz nicht überschreibbar');
  r=await post('close',code,{uid:B.__kr.uid()},B.ls['kr.sk']);
  ok(r.status===403,'Nicht-Host kann Raum nicht schließen');
  ok(!B.els.app.innerHTML.includes('data-a="close"')&&A.els.app.innerHTML.includes('data-a="close"'),'„Raum schließen“ nur beim Host');
  // ---- Sicherheit ----
  r=await fetch('http://localhost:3999/%E0%A4%A');
  const alive=(await fetch(BASE+'api?a=rooms')).status;
  ok(r.status===400&&alive===200,'Kaputte URL → 400, Server läuft weiter (früher: Absturz)');
  const kA=A.ls['kr.sk'],kB=B.ls['kr.sk'];
  r=await post('chip',code+'&n=1',{uid:A.__kr.uid(),hand:0,take:true},kB); ok(r.status===403,'Chip im Namen eines anderen → 403');
  r=await post('chat',code,{uid:A.__kr.uid(),text:'Fake'},kB); ok(r.status===403,'Chat im Namen eines anderen → 403');
  r=await post('set',code+'&path=room',{hostId:B.__kr.uid()},kB); ok(r.status===403,'Raum-Dokument (Host) nicht beschreibbar → 403');
  r=await post('set',code+'&path=state/main',{phase:'done'}); ok(r.status===403,'Nicht-Spieler kann Spielzustand nicht ändern → 403');
  r=await post('set',code+'&path=reveal/'+A.__kr.uid(),{hand:1},kB); ok(r.status===403,'Fremde Karten aufdecken → 403');
  r=await post('set',code+'&path=foo/bar',{x:1},kB); ok(r.status===403,'Unbekannter Pfad → 403');
  r=await post('set',code+'&path=players/uevil',{name:'<img src=x onerror=alert(1)>'+'y'.repeat(60),joinedAt:9e15},'evil-schluessel-000000000001');
  const ev=(await (await fetch(BASE+'api?a=get&room='+code+'&path=players/uevil')).json()).doc;
  ok(r.status===200&&!/[<>]/.test(ev.name)&&ev.name.length<=24,'Spielername bereinigt: „'+ev.name+'“');
  r=await post('kick',code,{uid:A.__kr.uid(),target:'uevil'},kA); ok(r.status===200,'Test-Eindringling wieder entfernt');
  await until(()=>A.__kr.S().players.length===3,'wieder 3');
  // ---- Einladen ----
  A.__kr.openInvite();
  ok(/class="panel invite"[^]*<svg/.test(A.els.app.innerHTML)&&A.els.app.innerHTML.includes('localhost:3999/r/'+code),'Einladen: QR-Code (SVG) + Link …/r/'+code+' (mit Vorschau)');
 
  const P=[A,B,C];
  A.__kr.startHand();
  await until(()=>P.every(x=>x.__kr.phase()==='play'&&x.__kr.myHand()),'Karten gegeben',30000);
  await until(()=>D.__kr.phase()==='play',''); await sleep(1500);
  ok(D.__kr.myHand()==null&&faces(D.els.app.innerHTML)===0,'Zuschauer sieht nach dem Geben keine einzige Karte');
  ok(faces(A.els.app.innerHTML)>=2,'Spielerin sieht ihre eigenen Karten');
  const plan={1:[1,2,3],2:[3,1,2],3:[2,3,1],4:[1,3,2]};
  for(let st=1;st<=4;st++){
    await until(()=>P.every(x=>x.__kr.stage()===st),'Runde '+st);
    if(st>1){ ok(P.every(x=>x.__kr.chipOf(x.__kr.uid())==null),'Runde '+st+': Chips wieder in der Mitte');
      await until(()=>D.__kr.stage()===st&&D.els.app.innerHTML.includes('class="hist"')&&D.els.app.innerHTML.includes('class="mchip'),'Zuschauer sieht Verlauf');
      const want=st===2?3:st===3?4:5;
      await until(()=>faces(D.els.app.innerHTML)===want,'Zuschauer sieht nur Tischkarten ('+want+')');
      ok(true,'Zuschauer sieht in Runde '+st+' nur die '+want+' aufgedeckten Tischkarten');
      await until(()=>(A.els.app.innerHTML.match(/card fresh/g)||[]).length===(st===2?3:1)&&A.els.app.innerHTML.includes('Neu aufgedeckt'),'Markierung neue Karte');
      ok((A.els.app.innerHTML.match(/class="mchip r\d/g)||[]).length>=3*(st-1)&&(st<4||A.els.app.innerHTML.includes('mchip r3')),'Mini-Chips in Rundenfarben (Runde '+(st-1)+')');
      ok((A.els.app.innerHTML.match(/chip big static r\d/g)||[]).length===st-1,'Große eigene Chips: '+(st-1)+' abgeschlossene Runde(n)');
      ok(!/animation/.test(A.els.app.innerHTML),'Neue Tischkarte(n) markiert ('+(st===2?3:1)+'), ohne Animation');
      ok(/Du hast: <b>[^<]+<\/b>/.test(A.els.app.innerHTML),'Anzeige „Du hast“: '+A.els.app.innerHTML.match(/Du hast: <b>([^<]+)/)[1]); }
    if(st===4)plan[4]=strengthPlan(P,false);
    P.forEach((x,k)=>x.__kr.takeChip(plan[st][k]));
    await until(()=>P.every(x=>P.every(y=>x.__kr.chipOf(y.__kr.uid())===plan[st][P.indexOf(y)])),'Chips Runde '+st);
    if(st===1){
      A.__kr.toggleFx(); ok(A.ls['kr.fx']==='0'&&A.els.app.innerHTML.includes('\u{1F515}'),'Ton/Vibration ausschaltbar (🔕, gemerkt)');
      A.__kr.toggleFx(); ok(A.ls['kr.fx']==='1','… und wieder an (🔔)');
    }
    if(st===1){
      await until(()=>A.els.app.innerHTML.includes('Warten auf:'),'Warten auf');
      const wa=A.els.app.innerHTML;
      ok(wa.includes('Warten auf:')&&wa.includes('<b>dich</b>')&&wa.includes('data-nudge="'+C.__kr.uid()+'"')&&!wa.includes('data-nudge="'+A.__kr.uid()+'"'),'„Warten auf: dich, Ben 👉, Cem 👉“');
      A.__kr.nudge(C.__kr.uid());
      await until(()=>/Anna stupst dich an/.test(toasts(C)),'Anstupsen kommt an'); ok(true,'Anstupsen: Cem bekommt „Anna stupst dich an 👉“');
      A.__kr.nudge(C.__kr.uid()); await until(()=>/Gerade erst/.test(toasts(A)),'Bremse'); ok(true,'Zweites Anstupsen sofort danach wird gebremst');
      // Ben nimmt Anna Chip 1 weg
      await sleep(1600); B.__kr.takeChip(1);
      await until(()=>/Ben hat dir Chip 1 genommen/.test(toasts(A)),'Chip-Hinweis'); ok(true,'Hinweis „Ben hat dir Chip 1 genommen“');
      B.__kr.takeChip(2); await sleep(700); A.__kr.takeChip(1);
      await until(()=>P.every(x=>P.every(y=>x.__kr.chipOf(y.__kr.uid())===plan[1][P.indexOf(y)])),'Chips wieder wie geplant');
      await until(()=>A.els.app.innerHTML.includes('class="pl me"'),'eigene Zeile');
      const hA=A.els.app.innerHTML,pos=n=>hA.indexOf('<div class="nm">'+n);
      ok(pos('Cem')<pos('Ben')&&pos('Ben')<pos('Anna'),'Spielerliste nach Chip sortiert (3 oben)');
      ok(/class="pl me"[^]*?<div class="nm">Anna/.test(hA),'Eigene Zeile farbig markiert');
      ok(hA.includes('Rangfolge der Hände')&&(hA.match(/card xs/g)||[]).length===50,'Ausklappbare Rangfolge mit Beispielkarten (10 × 5)');
      ok(!/Flop|Turn|River/.test(txt(hA))&&hA.includes('Runde 1 von 4'),'Keine Rundennamen, Überschrift „Runde 1 von 4“');
      ok(hA.includes('\u{1F44A} Bereit')&&!/>Set</.test(hA),'Knopf heißt „👊 Bereit“ statt „Set“');
      ok(/class="mychips"[^]*?chip big static r1 now">1</.test(hA),'Eigener Chip groß unter „Deine Karten“ (Runde 1, weiß)');
    }
    P.forEach(x=>x.__kr.toggleReady());
    if(st===1){
      await until(()=>A.__kr.cd().key&&A.els.app.innerHTML.includes('cd-num'),'Countdown läuft');
      const hc=A.els.app.innerHTML;
      ok(hc.includes('class="cd-overlay"')&&/cd-overlay[^]*data-a="ready"[^>]*>Bereit zurücknehmen/.test(hc),'Countdown als Overlay mit „Bereit zurücknehmen“');
      ok(!/cd-overlay[^]*data-a="ready"/.test(D.els.app.innerHTML),'Zuschauer bekommt keinen Zurücknehmen-Knopf');
      ok(true,'Countdown 3-2-1 erscheint');
      await sleep(1200); B.__kr.toggleReady();
      await sleep(3500); ok(A.__kr.stage()===1,'Set zurückgenommen → kein Aufdecken');
      B.__kr.toggleReady();
      const t0=Date.now(); await until(()=>A.__kr.stage()===2,'weiter nach Countdown');
      ok(Date.now()-t0>=2500,'Aufdecken erst nach Countdown ('+(Date.now()-t0)+' ms)');
    }
  }
  await until(()=>A.__kr.phase()==='guess'&&D.__kr.phase()==='guess','Tipp-Phase');
  await sleep(600); ok(faces(D.els.app.innerHTML)===5,'Zuschauer sieht in der Tipp-Phase keine Handkarten');
  const t=A.__kr.main().target, T=P[plan[4].indexOf(3)], GU=P.filter(x=>x!==T);
  ok(t===T.__kr.uid(),'Ziel = Spieler mit höchstem Chip');
  ok(A.__kr.guessers().length===2&&A.__kr.guessers().indexOf(t)<0,'Ziel-Spieler tippt nicht mit');
  await until(()=>T.els.app.innerHTML.includes('Du tippst nicht mit'),'Hinweis beim Ziel');
  ok(!T.els.app.innerHTML.includes('data-g='),'Ziel-Spieler hat keine Auswahlfelder');
  const real=T.__kr.myHand().cards.map(c=>c%13);
  const wrong=[0,1,2,3,4,5,6,7,8,9,10,11,12].find(r=>real.indexOf(r)<0);
  GU[0].__kr.setGuessCard(0,real[1]); await sleep(300); GU[1].__kr.setGuessCard(1,wrong); await sleep(1500);
  r=await fetch(BASE+'api?a=guess&room='+code,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:t,confirm:true})});
  ok(r.status===403,'Server lehnt Tipp vom Ziel-Spieler ab');
  GU[0].__kr.confirmGuess(); GU[1].__kr.confirmGuess();   // gleichzeitig – früher ging eine verloren
  await until(()=>A.__kr.phase()==='reveal','Aufdecken nach gleichzeitiger Bestätigung');
  ok(true,'Gleichzeitige Bestätigungen gehen nicht mehr verloren');
  for(let n=0;n<3;n++){
    const cur=A.__kr.main().revealOrder[A.__kr.main().revealIdx];
    const X=P.find(x=>x.__kr.uid()===cur);
    await until(()=>X.__kr.phase()==='reveal'&&X.__kr.main().revealIdx===n&&X.els.app.innerHTML.includes('data-a="reveal"'),'Knopf bei Aufdeckendem');
    X.__kr.revealMine();
    await until(()=>A.__kr.main().revealIdx===n+1,'Aufdecken '+(n+1));
  }
  await until(()=>A.__kr.phase()==='done'&&A.__kr.revealedCards(t),'Hand fertig'); await sleep(500);
  await until(()=>A.__kr.resolveHand(),'Auswertung');
  ok(A.els.app.innerHTML.includes('1 von 2 Karten richtig'),'Tipp: 1 von 2 Karten richtig erkannt');
  ok((A.els.app.innerHTML.match(/card sm hit/g)||[]).length===1&&(A.els.app.innerHTML.match(/card sm miss/g)||[]).length===1,'Getippte Karten einzeln grün/rot');
  let ex=expectWin(A.__kr,A.__kr.parts()), res=A.__kr.resolveHand();
  ok(ex.win&&res.orderOk&&!res.guessOk&&!res.win&&A.els.app.innerHTML.includes('Tipp daneben')&&!A.els.app.innerHTML.includes('Alles richtig'),
    'Hand 1: Reihenfolge stimmt, Tipp nur 1 von 2 → „Tipp daneben“, nicht „Alles richtig“');
  ok(/class="endbar"><span class="res bad">✗ Tipp daneben/.test(A.els.app.innerHTML),'Leiste zeigt „Tipp daneben“');
  { const h=A.els.app.innerHTML,a=h.indexOf('p-board'),b=h.indexOf('p-reveal'),c=h.indexOf('p-mine');
    ok(a>=0&&a<b&&b<c,'Raum: Auflösung unter dem Tisch und über der eigenen Hand'); }
  ok(/class="endbar".*data-a="start"/.test(A.els.app.innerHTML)&&/class="endbar".*Warten auf/.test(B.els.app.innerHTML)&&!/class="endbar".*data-a="start"/.test(B.els.app.innerHTML),
    'Leiste nach der Hand: Host hat „Neue Hand ▶“, Mitspieler „Warten auf …“');
  await until(()=>A.__kr.S().stats.length===1,'Statistik nach Hand 1');
  ok(A.__kr.S().stats[0].players.every(x=>Array.isArray(x.rounds)&&x.rounds.length===4&&x.rounds[3]===true),'Statistik: Treffer je Runde gespeichert (Runde 4 bei allen richtig)');
  ok(A.__kr.S().stats[0].win===false&&A.__kr.S().stats[0].players.length===3&&A.__kr.S().stats[0].players.every(x=>x.ok),'Statistik: Hand 1 nicht gewonnen (Tipp daneben), alle richtig platziert');
  ok(/0 von 1 Händen richtig/.test(A.els.app.innerHTML),'Statistik-Zeile nach der Hand');
  { const h1=A.__kr.hand();
    let rr=await post('record',code,{uid:'x',hand:h1,win:false,players:[{id:A.__kr.uid(),ok:false}]});
    ok(rr.status===403,'Statistik: Fremde dürfen nichts melden');
    rr=await post('record',code,{uid:A.__kr.uid(),hand:h1,win:true,players:[{id:A.__kr.uid(),ok:true}]},A.ls['kr.sk']);
    ok((await rr.json()).dup===true&&A.__kr.S().stats.length===1&&A.__kr.S().stats[0].win===false,'Statistik: zweite Meldung derselben Hand wird ignoriert');
    rr=await post('record',code,{uid:A.__kr.uid(),hand:h1+5,win:true,players:[{id:A.__kr.uid(),ok:true}]},A.ls['kr.sk']);
    ok(rr.status===409,'Statistik: nur die aktuelle, fertige Hand'); }
  ok((A.els.app.innerHTML.match(/tag res ok/g)||[]).length===3,'Alle drei Spieler mit ✓ markiert');
  const hands=(A.els.app.innerHTML.match(/class="tag hand">[^<]+/g)||[]).map(s=>s.replace('class="tag hand">',''));
  ok(hands.length===3,'Beim Aufdecken steht bei allen die Hand: '+hands.join(' | '));
  ok(/class="mchip[^>]*>1<[^]*?class="mchip[^>]*>3</.test(A.els.app.innerHTML),'Chip-Verlauf als Mini-Chips');
  // Hand 2: Reihenfolge absichtlich falsch herum
  A.__kr.startHand();
  await until(()=>P.every(x=>x.__kr.hand()===2&&x.__kr.phase()==='play'&&x.__kr.myHand()&&x.__kr.myHand().hand===2),'Hand 2 gegeben',30000);
  for(let st=1;st<=4;st++){
    await until(()=>P.every(x=>x.__kr.stage()===st&&x.__kr.phase()==='play'),'H2 Runde '+st);
    if(st===4)await until(()=>A.__kr.visibleBoard().length===5,'H2 River sichtbar');
    const pl=st===4?strengthPlan(P,true):[1,2,3];
    P.forEach((x,k)=>x.__kr.takeChip(pl[k]));
    await until(()=>P.every(x=>P.every(y=>x.__kr.chipOf(y.__kr.uid())===pl[P.indexOf(y)])),'H2 Chips '+st);
    P.forEach(x=>x.__kr.toggleReady());
  }
  await until(()=>A.__kr.phase()==='guess','H2 Tipp');
  const t2=A.__kr.main().target, G=P.filter(x=>x.__kr.uid()!==t2);
  G[0].__kr.setGuessCard(0,0); await sleep(400); G[0].__kr.setGuessCard(1,0); await sleep(1500);
  G.forEach(x=>x.__kr.confirmGuess());
  await until(()=>A.__kr.phase()==='reveal','H2 aufdecken');
  for(let n=0;n<3;n++){
    const cur=A.__kr.main().revealOrder[A.__kr.main().revealIdx];
    const X=P.find(x=>x.__kr.uid()===cur);
    await until(()=>X.__kr.phase()==='reveal'&&X.__kr.main().revealIdx===n&&X.els.app.innerHTML.includes('data-a="reveal"'),'H2 Knopf');
    X.__kr.revealMine();
    await until(()=>A.__kr.main().revealIdx===n+1,'H2 Aufdecken '+(n+1));
  }
  await until(()=>A.__kr.phase()==='done'&&A.__kr.resolveHand(),'H2 Auswertung'); await sleep(500);
  ok(P.every(x=>/Du bist dran: Karten aufdecken/.test(toasts(x))),'Jeder bekam beim Aufdecken „Du bist dran“');
  ex=expectWin(A.__kr,A.__kr.parts()); res=A.__kr.resolveHand();
  ok(res.orderOk===ex.win,'Hand 2: Auswertung stimmt mit unabhängiger Rechnung überein ('+(ex.win?'Gleichstand → richtig':ex.bad.size+' vertauscht')+')');
  await until(()=>A.__kr.S().stats.length===2,'Statistik nach Hand 2');
  { const st=A.__kr.calcStats(A.__kr.S().stats), bad=A.__kr.S().stats[1].players.filter(x=>!x.ok).length;
    const w2=ex.win&&res.guessOk;
    ok(A.__kr.S().stats[1].win===w2&&bad===ex.bad.size,'Statistik Hand 2 = Auswertung ('+bad+' falsch platziert)');
    ok(st.hands===2&&st.wins===(w2?1:0),'Statistik: 2 Hände, '+st.wins+' richtig, beste Serie '+st.best);
    ok(st.guesses>=1&&st.of>=st.hits,'Statistik zählt Tipp ('+st.hits+'/'+st.of+')');
    A.__kr.statsOpen(); const h=A.els.app.innerHTML;
    ok(/Statistik<\/h2>/.test(h)&&/Tipp-Treffer/.test(h)&&/class="me"/.test(h)&&(h.match(/<tr/g)||[]).length===4,'Statistik-Panel mit Kacheln und Tabelle (3 Spieler)');
    ok(/Deine Treffsicherheit/.test(h)&&/<th>R1<\/th>/.test(h)&&/Runde 4<\/small><b>\d+ %/.test(h),'Statistik: Treffsicherheit je Runde (Zeile + Spalten R1–R4)'); }
  if(!ex.win){
    ok(A.els.app.innerHTML.includes('Nicht ganz')&&/vertauscht mit [^<]+ · wäre Chip \d/.test(A.els.app.innerHTML),'Hand 2: „Nicht ganz“ + „vertauscht mit … · wäre Chip …“');
    const nBad=(A.els.app.innerHTML.match(/tag res bad/g)||[]).length;
    ok(nBad===ex.bad.size,'Genau die vertauschten Spieler rot markiert ('+nBad+')');
  }
  // Anna (Host) und Cem fallen gleichzeitig aus (Tab zu / Handy gesperrt)
  const aid=A.__kr.uid(), cid=C.__kr.uid(), t0=Date.now();
  A.__kr.leave(); C.__kr.leave();
  await until(()=>D.__kr.online()&&!D.__kr.isOnline(cid)&&!D.__kr.isOnline(aid),'beide offline',30000);
  await until(()=>/offline \d+ s/.test(D.els.app.innerHTML)&&D.els.app.innerHTML.includes('übernehmbar in'),'Offline-Dauer sichtbar');
  ok(!D.els.app.innerHTML.includes('data-take="'+cid+'"'),'Nach '+Math.round((Date.now()-t0)/1000)+' s: „offline … s“ + „übernehmbar in … s“, noch kein Knopf');
  r=await post('set',code+'&path=players/'+cid,{name:'Fake'});
  ok(r.status===403,'Server verweigert Übernahme vor 30 s');
  // Finn kommt neu auf die Startseite und springt direkt für Cem ein
  const F=client('Finn');
  await until(()=>F.els.roomlist.innerHTML.includes('data-a="jump"')&&F.els.roomlist.innerHTML.includes('data-id="'+cid+'"'),'Einspringen auf Startseite',60000);
  ok(F.els.roomlist.innerHTML.includes('Für Cem einspringen'),'Startseite nach '+Math.round((Date.now()-t0)/1000)+' s: „↪ Für Cem einspringen“');
  ok(!F.els.roomlist.innerHTML.includes('data-id="'+aid+'"'),'Für den Host kein Einspringen');
  r=await post('set',code+'&path=players/'+aid,{name:'Fake'});
  ok(r.status===403,'Server verweigert Übernahme des Host-Platzes');
  r=await post('close',code,{uid:aid});
  ok(r.status===403,'Raum bleibt vor fremdem Schlüssel geschützt');
  F.__kr.jumpIn(code,cid);
  await until(()=>F.__kr.uid()===cid&&!F.__kr.watching()&&B.__kr.pmap()[cid].pub.x===F.__kr.myPub().x,'Übernahme');
  ok(/Du spielst jetzt als Cem/.test(F.__kr.note()),'Finn spielt als Cem, mit Hinweis „Du spielst jetzt als Cem“');
  ok(B.__kr.S().players.length===3,'Weiterhin 3 Spieler');
  // Host-Rolle wandert, weil Anna zu lange weg ist
  await until(()=>B.__kr.isHost(),'Host-Wechsel',60000);
  ok(B.els.app.innerHTML.includes('data-a="close"'),'Nach '+Math.round((Date.now()-t0)/1000)+' s: Ben ist Host (kann schließen/kicken)');
  // Cems altes Gerät kommt zurück
  C.ls['kr.room']=code;
  const C2=client('',C.ls); await until(()=>/übernommen/.test(C2.__kr.note()),'altes Gerät');
  ok(!C2.__kr.code(),'Cems altes Gerät: „Platz wurde auf einem anderen Gerät übernommen“, kein Einstieg');
  // Anna kommt zurück: normale Spielerin
  A.ls['kr.room']=code;
  const A2=client('',A.ls); await until(()=>A2.__kr.code()===code,'Anna nach Reload zurück');
  ok(A2.__kr.uid()===aid&&!A2.__kr.isHost(),'Anna ist zurück, Host bleibt Ben');
  // Neuer Host kickt, dann schließt er
  B.__kr.kickPlayer(cid);
  await until(()=>!F.__kr.code()&&/entfernt/.test(F.__kr.err()),'Finn gekickt');
  await until(()=>B.__kr.S().players.length===2,'Ben sieht Kick'); ok(true,'Neuer Host kann Spieler entfernen');
  // ---- Schadcode im Spielzustand darf nirgends ausgeführt werden ----
  const evil='"><img src=x onerror=alert(1)>';
  r=await post('set',code+'&path=state/main',{phase:'done',hand:evil,stage:evil,participants:[aid,B.__kr.uid()],
    chipHist:{'1':{[aid]:evil}},opt:{holeCards:evil}},A.ls['kr.sk']);
  ok(r.status===200,'(Mitspielerin schreibt manipulierten Spielzustand)');
  await until(()=>B.__kr.main().hand===evil,'Zustand angekommen'); await sleep(300);
  ok(!/<img src=x/.test(B.els.app.innerHTML),'Manipulierter Zustand erzeugt kein HTML beim Mitspieler');
  await sleep(3100);   // Raumliste ist 3 s zwischengespeichert
  const rl0=await (await fetch(BASE+'api?a=rooms')).json(), me0=rl0.rooms.find(x=>x.code===code);
  ok(me0&&me0.hand===0&&!/img/.test(JSON.stringify(me0)),'Öffentliche Raumliste liefert nur saubere Werte');
  const V=client('Vera'); await until(()=>V.els.roomlist.innerHTML.includes(code),'Startseite');
  ok(!/<img src=x/.test(V.els.roomlist.innerHTML),'Startseite bleibt sauber');
  // ---- Einladungslink öffnen ----
  const I=client('Ines',null,{hash:'#'+code.toLowerCase()}); await sleep(600);
  ok(I.__kr.inviteCode()===code&&I.els.app.innerHTML.includes('eingeladen')&&I.els.app.innerHTML.includes('value="'+code+'"'),'Link …/#'+code+' → Hinweis „eingeladen“ + Code vorausgefüllt');
  // ---- Raum-Flut von einer IP ----
  let codes=[]; for(let i=0;i<25;i++){ const rr=await fetch(BASE+'api?a=create&room=FL'+i,{method:'POST',headers:{'Content-Type':'application/json','x-forwarded-for':'203.0.113.9'},body:'{"hostId":"x"}'}); codes.push(rr.status); }
  ok(codes.filter(s=>s===200).length===20&&codes.slice(20).every(s=>s===429),'Raum-Flut: nach 20 neuen Räumen je IP → 429');
  const E=client('Emil'); await sleep(500); E.__kr.watchRoom(code); await until(()=>E.__kr.S().players.length===2,'Emil schaut zu');
  B.__kr.closeRoom();
  await until(()=>!A2.__kr.code()&&!D.__kr.code()&&!E.__kr.code(),'alle raus nach Schließen');
  ok(/geschlossen/.test(D.__kr.err())&&/geschlossen/.test(E.__kr.err())&&/geschlossen/.test(A2.__kr.err()),'Host schließt Raum → alle bekommen Hinweis');
  const rl=await (await fetch(BASE+'api?a=rooms')).json();
  ok(!rl.rooms.some(x=>x.code===code),'Raum verschwindet aus der Liste');
  // Zähler für die Startseite: gespielte Hände in Räumen und im Übungsraum
  ok(rl.counts&&rl.counts.mp>=2,'Startseite: Zähler Hände in Räumen ('+rl.counts.mp+')');
  const sp0=rl.counts.sp;
  for(let k=0;k<3;k++)await fetch(BASE+'api?a=sphand',{method:'POST',headers:{'Content-Type':'application/json','x-forwarded-for':'203.0.113.77'},body:'{}'});
  const rl2=await (await fetch(BASE+'api?a=rooms')).json();
  ok(rl2.counts.sp===sp0+1,'Übungsraum-Zähler: 3 Meldungen in Folge von einer IP zählen nur einmal');
  await until(()=>/Bisher gespielt: <b>\d+<\/b> Hände? in Räumen · <b>\d+<\/b> im Übungsraum/.test(V.els.playcount.innerHTML),'Zähler auf der Startseite',8000);
  ok(true,'Startseite zeigt „Bisher gespielt: … Hände in Räumen · … im Übungsraum“');
  { const h=V.els.app.innerHTML; ok(h.indexOf('id="playcount"')>h.indexOf('So läuft eine Hand')&&/href="impressum.html">Impressum<\/a>/.test(h)&&/impressum.html#datenschutz/.test(h),'Startseite: Statistik ganz unten, darunter Impressum und Datenschutz'); }
  { const imp=await (await fetch(BASE+'impressum.html')).text(); ok(/Sachsenstr\. 1/.test(imp)&&/§ 5 Digitale-Dienste-Gesetz/.test(imp)&&/id="datenschutz"/.test(imp),'Impressum + Datenschutz erreichbar'); }
  // ---- Geplanter Raum: Link vorab, Beitritt erst ab Startzeit, erster Spieler wird Host ----
  const pad=x=>String(x).padStart(2,'0'), local=t=>{const d=new Date(t);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());};
  const Pl=client('Paula'); await sleep(400);
  const startAt=Math.ceil((Date.now()+8000)/1000)*1000;
  Pl.els.sname={value:'Spieleabend'}; Pl.els.stime={value:local(startAt)};
  Pl.__kr.planRoom(); await until(()=>Pl.__kr.planned().length===1,'Raum geplant');
  const pc=Pl.__kr.planned()[0].code;
  ok(Pl.els.app.innerHTML.includes('/r/'+pc)&&Pl.els.app.innerHTML.includes('Deine geplanten Räume'),'Planer bekommt Link und Liste „Deine geplanten Räume“');
  ok(!Pl.__kr.code(),'Planer ist nicht automatisch im Raum');
  // Vorschau für WhatsApp & Co.: /r/CODE liefert og:-Angaben und leitet auf /#CODE weiter
  ok(Pl.__kr.inviteUrl(pc)==='http://localhost:3999/r/'+pc,'Einladungslink ist …/r/'+pc);
  let og=await (await fetch(BASE+'r/'+pc)).text();
  ok(/og:title" content="„Spieleabend“ – Letzte Runde"/.test(og)&&/og:description" content="Lass uns eine letzte Runde spielen – am [^"]+ um \d\d:\d\d Uhr \([^)]+\)\."/.test(og),'Vorschau: Titel mit Name, Text „Lass uns eine letzte Runde spielen – am … um … Uhr (Zone)“');
  ok(og.includes('http-equiv="refresh" content="0;url=/#'+pc+'"')&&og.includes('og:image" content="http://localhost:3999/icon-512.png"'),'Vorschau: Bild + Weiterleitung auf /#'+pc);
  await post('create','ZZTZ',{startsAt:Date.UTC(2026,8,30,18,0),name:'Test "&" Runde',tz:'Europe/Berlin'});
  og=await (await fetch(BASE+'r/ZZTZ')).text();
  ok(og.includes('um 20:00 Uhr (MESZ)')&&og.includes('Test &quot;&amp;&quot; Runde'),'Zeitzone des Planenden (Europe/Berlin → 20:00 Uhr MESZ), Sonderzeichen maskiert');
  await post('create','ZZTZ2',{startsAt:Date.UTC(2026,8,30,18,0),tz:'Evil/"><script>'});
  ok((await (await fetch(BASE+'r/ZZTZ2')).text()).includes('(MESZ)'),'Ungültige Zeitzone → Europe/Berlin');
  og=await new Promise((res)=>require('http').get({host:'localhost',port:3999,path:'/r/'+pc,headers:{Host:'evil.example"><x'}},(r)=>{let d='';r.on('data',(c)=>d+=c);r.on('end',()=>res(d));}));
  ok(!og.includes('evil')&&og.includes('https://gang.aize.eu/r/'+pc),'Gefälschter Host-Header landet nicht in der Vorschau');
  og=await (await fetch(BASE+'r/NOPE9')).text();
  ok(/Lass uns eine letzte Runde spielen!/.test(og)&&og.includes('url=/#NOPE9'),'Unbekannter Raum: allgemeine Vorschau, Weiterleitung');
  let inf=await (await fetch(BASE+'api?a=info&room='+pc)).json();
  ok(inf.startsAt===startAt&&inf.name==='Spieleabend'&&inf.players===0,'Server kennt Startzeit und Name');
  const Q=client('Quinn',null,{hash:'#'+pc}); await until(()=>Q.__kr.inviteInfo()&&Q.__kr.inviteInfo().startsAt,'Einladungsinfo');
  ok(/Spieleabend/.test(Q.els.app.innerHTML)&&/noch/.test(Q.els.app.innerHTML)&&/data-left/.test(Q.els.app.innerHTML),'Einladung zeigt Name, Startzeit und Restzeit');
  Q.__kr.joinRoom(pc); await sleep(500);
  ok(!Q.__kr.code()&&/öffnet erst/.test(Q.__kr.err()),'Beitreten vor Start im Client gesperrt: '+Q.__kr.err());
  r=await post('set',pc+'&path=players/frueh',{name:'Frühvogel'},'frueh-schluessel-00000001');
  ok(r.status===403,'Beitreten vor Start auch am Server gesperrt (403)');
  ok((await post('create','ZZP1',{startsAt:Date.now()+40*86400000})).status===400,'Startzeit über 30 Tage → 400');
  ok((await post('create','ZZP2',{startsAt:Date.now()-5000})).status===400,'Startzeit in der Vergangenheit → 400');
  await until(()=>Date.now()>startAt+300,'Startzeit erreicht',15000);
  const Ri=client('Rita',null,{hash:'#'+pc}); await sleep(600);
  Ri.__kr.joinRoom(pc); await until(()=>Ri.__kr.S().players.length===1,'Rita im Raum');
  await until(()=>Ri.__kr.S().room&&Ri.__kr.S().room.hostId===Ri.__kr.uid(),'Rita wird Host');
  ok(Ri.__kr.isHost(),'Erster Spieler nach Start ist Host');
  Q.__kr.joinRoom(pc); await until(()=>Q.__kr.S().players.length===2,'Quinn im Raum');
  ok(!Q.__kr.isHost()&&Q.__kr.S().room.hostId===Ri.__kr.uid(),'Zweiter Spieler ist nicht Host');
  r=await post('set',pc+'&path=players/'+Q.__kr.uid(),{name:'Quinn',joinedAt:1},Q.ls['kr.sk']);
  await sleep(300); const qd=(await (await fetch(BASE+'api?a=get&room='+pc+'&path=players/'+Q.__kr.uid())).json()).doc;
  ok(qd.joinedAt>1000&&Ri.__kr.isHost(),'Gefälschtes Beitrittsdatum wird ignoriert, Host bleibt');
  Ri.__kr.closeRoom(); await until(()=>!Q.__kr.code(),'geplanter Raum geschlossen');
  console.log('ALLE TESTS BESTANDEN');process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
