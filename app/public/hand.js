/**
 * Handbewertung für „Letzte Runde“ – eine Quelle für Browser (index.html, Übungsraum) und Server (Bots im Raum).
 * Karten: 0..51, Wert = c % 13 (0 = 2 … 12 = Ass), Farbe = floor(c / 13).
 * Hausregeln stehen in bestHand(): Kombination zählt nur, wenn die eigenen Karten sie verbessern; Flush/Straße nach
 * eigener höchster Karte. Keine Abhängigkeiten, kein DOM.
 */
(function(root){
function eval5(cs){
  var cnt={},i;
  for(i=0;i<cs.length;i++){var r=cs[i]%13;cnt[r]=(cnt[r]||0)+1;}
  var g=Object.keys(cnt).map(function(r){return [cnt[r],+r];}).sort(function(a,b){return b[0]-a[0]||b[1]-a[1];});
  var flush=false,straight=-1;
  if(cs.length===5){
    flush=cs.every(function(c){return Math.floor(c/13)===Math.floor(cs[0]/13);});
    if(g.length===5){
      if(g[0][1]-g[4][1]===4)straight=g[0][1];
      else if(g[0][1]===12&&g[1][1]===3)straight=3;           // A-2-3-4-5
    }
  }
  var cat=0;
  if(straight>=0&&flush)cat=straight===12?9:8;
  else if(g[0][0]===4)cat=7;
  else if(g[0][0]===3&&g[1]&&g[1][0]>=2)cat=6;
  else if(flush)cat=5;
  else if(straight>=0)cat=4;
  else if(g[0][0]===3)cat=3;
  else if(g[0][0]===2&&g[1]&&g[1][0]===2)cat=2;
  else if(g[0][0]===2)cat=1;
  var tb=(cat===4||cat>=8)?[straight]:g.map(function(x){return x[1];});
  return {cat:cat,tb:tb,groups:g,straight:straight};
}
function cmpHand(a,b){
  if(a.cat!==b.cat)return a.cat-b.cat;
  for(var i=0;i<Math.max(a.tb.length,b.tb.length);i++){var d=(a.tb[i]!=null?a.tb[i]:-1)-(b.tb[i]!=null?b.tb[i]:-1);if(d)return d;}
  return 0;
}
/* Beste Hand aus beliebig vielen Karten (Handkarten + sichtbarer Tisch).
   Hausregel: Bleibt es bei "Höchste Karte", zählen nur die eigenen Handkarten (hole). */
function bestHand(cards,hole){
  cards=cards.filter(function(c){return c!=null;});
  if(!cards.length)return null;
  var best=null,n=cards.length;
  if(n<=5)best=eval5(cards);
  else for(var a=0;a<n;a++)for(var b=a+1;b<n;b++)for(var c=b+1;c<n;c++)for(var d=c+1;d<n;d++)for(var e=d+1;e<n;e++){
    var h=eval5([cards[a],cards[b],cards[c],cards[d],cards[e]]);
    if(!best||cmpHand(h,best)>0)best=h;
  }
  if(hole&&hole.length){
    var own=hole.filter(function(c){return c!=null;});
    var board=cards.filter(function(c){return own.indexOf(c)<0;});
    /* Hausregel: Eine Kombination zählt nur, wenn die eigenen Karten sie verbessern (höhere Kategorie als der Tisch
       allein oder höherer Kern). Wer nur Beikarten zum Tisch-Paar/-Flush beisteuert, hat „Höchste Karte“ aus der Hand. */
    if(best.cat>0&&board.length&&!ownImproves(best,bestHand(board)))best={cat:0,tb:[],groups:[],straight:-1};
    if(best.cat===0)best.tb=own.map(function(c){return c%13;}).sort(function(x,y){return y-x;});
    if(best.cat===5){
      /* Flush: es zählt die eigene höchste Karte in der Flush-Farbe (der König vom Tisch haben alle) */
      var cnt=[0,0,0,0];cards.forEach(function(c){cnt[Math.floor(c/13)]++;});
      var suit=cnt.indexOf(Math.max.apply(null,cnt));
      var mine=own.filter(function(c){return Math.floor(c/13)===suit;}).map(function(c){return c%13;});
      if(mine.length){best.ownHigh=Math.max.apply(null,mine);best.tb=[best.ownHigh].concat(best.tb);}
    }
    if(best.cat===4){
      /* Straße: benannt nach der eigenen höchsten Karte in der Straße (Wertung weiter nach der obersten Karte) */
      var top=best.straight,seq=top===3?[12,0,1,2,3]:[top-4,top-3,top-2,top-1,top],pos=-1;
      own.forEach(function(c){var i=seq.indexOf(c%13);if(i>pos)pos=i;});
      if(pos>=0)best.ownHigh=seq[pos],best.ownLowAce=(top===3&&pos===0);
    }
  }
  return best;
}
/* Kern einer Hand: bei Paar/Drilling/Vierling/Full House die Werte der Gruppen, sonst alle Werte (Straße, Flush) */
function handCore(h){
  if(h.cat===4||h.cat===5||h.cat>=8)return h.tb;
  return (h.groups||[]).filter(function(g){return g[0]>=2;}).map(function(g){return g[1];});
}
function ownImproves(mine,board){
  if(!board||mine.cat!==board.cat)return !board||mine.cat>board.cat;
  var a=handCore(mine),b=handCore(board);
  for(var i=0;i<Math.max(a.length,b.length);i++){var d=(a[i]!=null?a[i]:-1)-(b[i]!=null?b[i]:-1);if(d)return d>0;}
  return false;
}

/* Monte-Carlo: fremde Handkarten und fehlende Tischkarten zufällig ergänzen und zählen, wie viele Hände
   schwächer sind → erwarteter Rang 1..(others+1) am Ende (1 = schwächste Hand). */
/* Vor dem Flop: Tabelle statt Monte-Carlo (sonst rechnet der Browser je Bot eine halbe Sekunde). Wert = Anteil gewonnener
   Einzelduelle in Promille (Hausregel, Unentschieden halb), erzeugt mit tests/gen-preflop.js. Index siehe preKey. */
var PRE=[495,303,338,531,314,351,343,373,564,333,367,353,388,378,407,600,329,366,356,393,376,410,399,432,628,339,379,359,394,385,418,408,439,427,459,663,363,398,372,405,390,424,415,448,436,464,454,483,692,387,422,400,429,406,435,433,459,452,477,472,496,485,513,721,411,443,421,457,436,462,445,475,468,494,484,509,504,526,519,547,748,436,469,446,481,460,489,475,503,487,511,503,529,516,546,537,565,555,578,776,468,492,480,506,493,521,505,529,520,537,526,546,544,568,562,579,581,601,586,607,802,495,526,510,539,517,550,536,565,545,574,558,583,564,589,585,603,601,623,615,632,616,637,825,545,568,554,577,566,589,583,603,582,603,593,616,604,622,613,633,628,650,641,658,649,668,658,674,854];
function preKey(hole){
  var a=Math.max(hole[0]%13,hole[1]%13),b=Math.min(hole[0]%13,hole[1]%13),s=Math.floor(hole[0]/13)===Math.floor(hole[1]/13)?1:0;
  return a*a+2*b+s;   // je hohe Karte x liegen 2x+1 Einträge (b<x ungleichfarbig/gleichfarbig, Paar) → vor a: a·a
}
function estimateRank(hole,vis,others,K,sims){
  if(!vis.length&&K===2&&PRE)return 1+others*PRE[preKey(hole)]/1000;
  var known={},deck=[],i,s,sum=0;
  sims=sims||160;
  hole.concat(vis).forEach(function(c){known[c]=1;});
  for(i=0;i<52;i++)if(!known[i])deck.push(i);
  /* Voller Tisch, 2 Handkarten: exakt über alle möglichen Gegnerhände rechnen (kein Zufall → gleiche Hand, gleiche Einschätzung) */
  if(vis.length===5&&K===2){
    var me=bestHand(hole.concat(vis),hole),win=0,cnt=0;
    for(i=0;i<deck.length;i++)for(var j=i+1;j<deck.length;j++){
      var oh=[deck[i],deck[j]],y=cmpHand(me,bestHand(oh.concat(vis),oh));
      win+=y>0?1:y===0?0.5:0;cnt++;
    }
    return 1+others*win/cnt;
  }
  var need=others*K+(5-vis.length);
  for(s=0;s<sims;s++){
    var d=deck.slice();
    for(i=0;i<need;i++){var j=i+Math.floor(Math.random()*(d.length-i)),t=d[i];d[i]=d[j];d[j]=t;}
    var board=vis.concat(d.slice(others*K,need)),mine=bestHand(hole.concat(board),hole),rank=1;
    for(var o=0;o<others;o++){
      var oh=d.slice(o*K,o*K+K),x=cmpHand(mine,bestHand(oh.concat(board),oh));
      if(x>0)rank+=1;else if(x===0)rank+=0.5;
    }
    sum+=rank;
  }
  return sum/sims;
}

/* Rückschluss (Ausschlussverfahren): Welche Handkarten passen zu den Chips, die jemand je Runde genommen hat?
   o = {board:[bis 5 Tischkarten], dead:[Karten, die er sicher nicht hat], chips:{1..4: Chip}, n: Spielerzahl, K: Handkarten,
        beats:[[Karten]…] Hände, die er am Ende schlagen soll (weich gewichtet)}.
   Jede mögliche Hand bekommt ein Gewicht: je Runde passt ihre Stärke (Anteil schwächerer Hände bei den damals sichtbaren
   Tischkarten; vor dem Flop Tabelle PRE) zum genommenen Chip? Liefert [{hole,w}] mit Summe 1, stärkstes Gewicht zuerst. */
var SEEN=[0,3,4,5];
function inferHole(o){
  var K=o.K||2,n=o.n,dead={},deck=[],combos=[],i,j,k;
  (o.board||[]).concat(o.dead||[]).forEach(function(c){dead[c]=1;});
  for(i=0;i<52;i++)if(!dead[i])deck.push(i);
  if(K===2){for(i=0;i<deck.length;i++)for(j=i+1;j<deck.length;j++)combos.push([deck[i],deck[j]]);}
  else{
    var seen={};
    for(k=0;k<1500;k++){
      var d=deck.slice();for(i=0;i<K;i++){j=i+Math.floor(Math.random()*(d.length-i));var t=d[i];d[i]=d[j];d[j]=t;}
      var h=d.slice(0,K).sort(function(a,b){return a-b;}),key=h.join();if(!seen[key]){seen[key]=1;combos.push(h);}
    }
  }
  var w=combos.map(function(){return 1;}),sig=[0,1.1,1,0.85,0.7];
  for(var r=1;r<=4;r++){
    var chip=o.chips&&o.chips[r];if(!chip)continue;
    var vis=(o.board||[]).slice(0,SEEN[r-1]);if(vis.length<SEEN[r-1])continue;
    var pct;
    if(!vis.length&&K===2)pct=combos.map(function(h){return PRE[preKey(h)]/1000;});
    else{      // Stärke = Anteil der möglichen Hände, die schwächer sind (Unentschieden halb)
      var hs=combos.map(function(h,x){return {x:x,h:bestHand(h.concat(vis),h)};});
      hs.sort(function(a,b){return cmpHand(a.h,b.h);});
      pct=new Array(combos.length);
      for(i=0;i<hs.length;){for(j=i;j+1<hs.length&&cmpHand(hs[j+1].h,hs[i].h)===0;j++);
        for(k=i;k<=j;k++)pct[hs[k].x]=(i+j)/2/Math.max(1,hs.length-1);i=j+1;}
    }
    var s=sig[r]*Math.max(1,(n-1)/3);
    for(i=0;i<combos.length;i++){var ex=1+pct[i]*(n-1),dd=(chip-ex)/s;w[i]*=Math.exp(-dd*dd/2);}
  }
  if(o.beats&&o.beats.length&&(o.board||[]).length===5){
    var bh=o.beats.map(function(h){return bestHand(h.concat(o.board),h);});
    for(i=0;i<combos.length;i++){
      var mine=bestHand(combos[i].concat(o.board),combos[i]);
      bh.forEach(function(b){var c=cmpHand(mine,b);if(c<0)w[i]*=0.03;else if(c===0)w[i]*=0.5;});
    }
  }
  var sum=0,out=[];for(i=0;i<combos.length;i++)sum+=w[i];
  for(i=0;i<combos.length;i++)if(w[i]>0)out.push({hole:combos[i],w:w[i]/(sum||1)});
  return out.sort(function(a,b){return b.w-a.w;});
}
/* Wahrscheinlichkeit je Kartenwert (0…12), dass er mindestens einmal in der Hand ist */
function rankOdds(list){
  var p=[0,0,0,0,0,0,0,0,0,0,0,0,0];
  list.forEach(function(x){var s={};x.hole.forEach(function(c){s[c%13]=1;});for(var r in s)p[r]+=x.w;});
  return p;
}
/* Wahrscheinlichste Kombination von Werten (Farbe egal, wie beim Tipp): [{vals:[…], w}] absteigend */
function valueOdds(list){
  var m={};
  list.forEach(function(x){var k=x.hole.map(function(c){return c%13;}).sort(function(a,b){return b-a;}).join();m[k]=(m[k]||0)+x.w;});
  return Object.keys(m).map(function(k){return {vals:k.split(',').map(Number),w:m[k]};}).sort(function(a,b){return b.w-a.w;});
}

var api={eval5:eval5,cmpHand:cmpHand,bestHand:bestHand,handCore:handCore,ownImproves:ownImproves,estimateRank:estimateRank,preKey:preKey,
  inferHole:inferHole,rankOdds:rankOdds,valueOdds:valueOdds};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
else for(var k in api)root[k]=api[k];
})(typeof globalThis!=='undefined'?globalThis:this);
