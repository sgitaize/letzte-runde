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
function estimateRank(hole,vis,others,K,sims){
  var known={},deck=[],i,s,sum=0;
  sims=sims||160;
  hole.concat(vis).forEach(function(c){known[c]=1;});
  for(i=0;i<52;i++)if(!known[i])deck.push(i);
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

var api={eval5:eval5,cmpHand:cmpHand,bestHand:bestHand,handCore:handCore,ownImproves:ownImproves,estimateRank:estimateRank};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
else for(var k in api)root[k]=api[k];
})(typeof globalThis!=='undefined'?globalThis:this);
