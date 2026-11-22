// Demo-only API. This file and the preview page are outside production webapp assets.
(() => {
  const params = new URL(location.href).searchParams;
  let theme = params.get("theme") || "light";
  const state = params.get("state") || "normal";
  const admin = params.get("role") === "admin";
  const now = () => Math.floor(Date.now() / 1000);
  let balance = 72;
  const profile = () => ({id:1,name:"Твой ник",username:"tots_player",registered_at:now()-86400*24,balance,is_admin:admin,is_new:false,photo_url:null,stats:{earned:112,spent:40}});
  const settings={time_limit:60,attempts:1,every_days:1};
  const questions=[{id:1,opened:false,done:false,correct:false,attempts_left:1},{id:2,opened:false,done:false,correct:false,attempts_left:1},{id:3,opened:true,done:true,correct:true,answer:"Милан",text:"Какой клуб называют россонери?",attempts_left:0}];
  const texts={1:"Какой клуб выиграл Лигу чемпионов в 2005 году?",2:"Как называется домашний стадион «Ливерпуля»?"};
  const quiz = () => ({now:now(),qualify:100,settings,current:state==='empty'?null:{id:1,title:"Вечера Лиги чемпионов",reward:1,ends_at:now()+7200,questions},past:[{id:2,title:"Легенды футбола",right:4,total:5}]});
  const match = {id:1,tournament:"CL",tournament_name:"Лига чемпионов",home:"Арсенал",away:"Интер",start_time:now()+5400,status:"scheduled",open:true,has_score:true,score:null,my:[]};
  const odds={"1x2":{"1":2.1,"X":3.2,"2":3.6},score:{"1:0":8,"1:1":6.5,"0:1":10,"2:0":11,"2:1":8.5,"0:2":15,"2:2":12}};
  const players=[{id:2,name:"Северная трибуна",quiz:24,won:9,bets:15,accuracy:60,rating:5.4,change:-1},{id:1,name:"Твой ник",quiz:18,won:8,bets:10,accuracy:80,rating:6.4,change:1},{id:3,name:"Голос стадиона",quiz:15,won:7,bets:12,accuracy:58,rating:4.1,change:0},{id:4,name:"Новый игрок",quiz:2,won:1,bets:3,accuracy:null,rating:null,change:0}].sort((a,b)=>(b.rating??-1)-(a.rating??-1)).map((p,i)=>({...p,rank:i+1}));
  const transactions=[{id:3,type:"quiz_reward",amount:1,quiz:"Легенды футбола",created_at:now()-600},{id:2,type:"bet",amount:-10,match:"Арсенал — Интер",market:"1x2",outcome:"1",created_at:now()-86400},{id:1,type:"payout",amount:18,match:"Бавария — Бенфика",market:"1x2",outcome:"1",created_at:now()-86400*2}];
  const handlers = new Map();
  window.Telegram={WebApp:{initData:"local-demo-only",initDataUnsafe:{start_param:params.get('tab')||'quizzes'},get colorScheme(){return theme;},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},onEvent(name,fn){handlers.set(name,fn);},HapticFeedback:{notificationOccurred(){}}}};
  const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  window.fetch=async(input,options={})=>{
    const url=new URL(input,location.href),path=url.pathname;
    // Never fall through to a real API, even when a demo handler is missing.
    if(!path.startsWith('/api/'))return response({error:'Недоступно в демонстрации'},404);
    if(path==='/api/me')return response(profile());
    if(state==='loading'&&!path.startsWith('/api/admin/'))return new Promise(()=>{});
    if(state==='error'&&!path.startsWith('/api/admin/'))return response({error:'Демонстрация ошибки сети. Попробуйте ещё раз.'},503);
    const body=options.body?JSON.parse(options.body):{};
    if(path==='/api/quiz')return response(quiz());
    const questionPath=/^\/api\/quiz\/questions\/(\d+)\/(open|answer)$/.exec(path);
    if(questionPath){const q=questions.find(q=>q.id===Number(questionPath[1]));if(!q)return response({error:'Вопрос не найден'},404);
      if(questionPath[2]==='open'){q.opened=true;q.text=texts[q.id];q.deadline=now()+60;}
      else {if(q.done)return response({error:'Ответ уже принят'},409);q.answer=body.answer;q.correct=q.answer.toLowerCase().includes(q.id===1?'ливерпул':'энфилд');q.done=true;q.attempts_left=0;if(q.correct)balance++;}
      return response({now:now(),question:q,correct:q.correct,balance});}
    if(path==='/api/quizzes/2')return response({title:'Легенды футбола',ended:true,questions:[{id:7,text:'Кто выиграл ЛЧ в 2005 году?',correct:true,answer:'Ливерпуль',answers:['Ливерпуль'],done:true}]});
    if(path==='/api/history')return response({items:state==='empty'?[]:transactions,next:null});
    if(path==='/api/leaderboard')return response({period:url.searchParams.get('period')||'all',sort:'weighted_accuracy',since:null,total:state==='empty'?0:players.length,rows:state==='empty'?[]:players,me:state==='empty'?null:players.find(p=>p.id===1)});
    if(path==='/api/users/2')return response({...profile(),...players.find(p=>p.id===2),registered_at:now()-86400*80});
    if(path==='/api/matches')return response({now:now(),tournaments:[{code:'CL',name:'Лига чемпионов'},{code:'PL',name:'АПЛ'}],matches:state==='empty'||url.searchParams.get('t')==='PL'?[]:[{...match,odds:odds['1x2']}]});
    if(path==='/api/matches/1')return response({...match,odds});
    if(path==='/api/predictions'&&options.method==='POST'){
      const stake=body.stake;if(!Number.isInteger(stake)||stake<1||stake>100)return response({error:'Введите целую сумму от 1 до 100 BIST'},400);
      const previous=match.my[0];if(stake>balance+(previous?.stake||0))return response({error:'Недостаточно BIST'},409);
      balance+=previous?.stake||0;balance-=stake;
      match.my=[{id:1,status:'active',market:body.market,outcome:body.outcome,stake,price:odds[body.market][body.outcome],payout:stake*odds[body.market][body.outcome],next_change_at:0}];return response({balance,replaced:!!previous});}
    if(path==='/api/predictions/1/cancel'){balance+=match.my[0]?.stake||0;match.my=[];return response({balance});}
    if(path==='/api/predictions')return response({items:state==='empty'?[]:match.my.map(p=>({...p,match})),next:null});
    if(path==='/api/admin/quizzes')return response({settings,quizzes:[{...quiz().current,status:'current',players:12,questions:[{id:1,text:texts[1],answers:['Ливерпуль']}]}]});
    if(path==='/api/admin/audit')return response({entries:[]});
    if(path==='/api/admin/dashboard'){
      const period=value=>({day:value,week:value*3,month:value*8,all:value*12});
      return response({bist:{issued:period(42),spent:period(24),by_type:[],total:856},players:{total:24,new:period(2),active:period(8),qualify_bist:100,qualified:3,top_n:3,top_share:32},predictions:{made:period(12),players:period(6),stake:period(70),won:period(5),lost:period(3),payout:period(98),active:{count:4,stake:32}},quizzes:{players:period(12),opened:period(28),correct:period(19),wrong:period(9),queue_until:now()+86400*3}});
    }
    if(path.startsWith('/api/admin/'))return response({error:'Административные изменения недоступны в демо'},403);
    return response({error:'Этот сценарий не подключён в демо'},404);
  };
  document.addEventListener('DOMContentLoaded',()=>{
    for(const [id,value] of [['preview-theme',theme],['preview-state',state],['preview-role',admin?'admin':'player']])document.getElementById(id).value=value;
    document.getElementById('preview-theme').onchange=e=>{theme=e.target.value;handlers.get('themeChanged')?.();};
    for(const key of ['state','role'])document.getElementById('preview-'+key).onchange=e=>{const u=new URL(location.href);u.searchParams.set(key,e.target.value);const tab=document.querySelector('#nav button.active')?.dataset.tab;if(tab)u.searchParams.set('tab',tab);location.href=u;};
  });
})();
