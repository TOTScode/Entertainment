// Demo-only API. This file and the preview page are outside production webapp assets.
(() => {
  const params = new URL(location.href).searchParams;
  let theme = params.get("theme") || "light";
  const state = params.get("state") || "normal";
  const admin = params.get("role") === "admin";
  const now = () => Math.floor(Date.now() / 1000);
  const firstStart=1796072400, firstEnd=1803848400;
  const pending=()=>now()<firstStart;
  let balance = 72;
  let prefs={public_profile:false,public_avatar:false,marketing_opt_in:false,marketing_opt_out:false};const requests=[];
  const photo = params.get('avatar') === 'none' ? null : params.get('avatar') === 'broken' ? 'design/missing-avatar.png' : 'design/demo-avatar.svg';
  const profile = () => ({id:1,name:"Твой ник",username:"tots_player",registered_at:now()-86400*24,balance,is_admin:admin,is_new:false,photo_url:photo,preferences:prefs,stats:{earned:112,spent:40}});
  const settings={time_limit:20,attempts:1,every_days:1};
  const questions=[{id:1,opened:false,done:false,correct:false,attempts_left:1},{id:2,opened:false,done:false,correct:false,attempts_left:1},{id:3,opened:true,done:true,correct:true,answer:"Милан",text:"Какой клуб называют россонери?",attempts_left:0}];
  const texts={1:"Какой клуб выиграл Лигу чемпионов в 2005 году?",2:"Как называется домашний стадион «Ливерпуля»?"};
  const quiz = () => ({now:now(),qualify:100,settings,current:state==='empty'?null:{id:1,title:"Вечера Лиги чемпионов",reward:1,ends_at:now()+7200,questions},past:[{id:2,title:"Легенды футбола",right:4,total:5}]});
  const match = {id:1,tournament:"CL",tournament_name:"Лига чемпионов",home:state==='long'?"Спортивный клуб объединённой университетской команды Северного района":"Арсенал",away:state==='long'?"Футбольная академия международного спортивного сообщества":"Интер",start_time:now()+(state==='live'?-1800:5400),status:"scheduled",open:admin||(state!=='live'&&!pending()),admin_mode:admin,has_score:true,score:null,my:[]};
  const odds={"1x2":{"1":2.1,"X":3.2,"2":3.6},score:{"1:0":8,"1:1":6.5,"0:1":10,"2:0":11,"2:1":8.5,"0:2":15,"2:2":12}};
  if(state==='live')match.my=[{id:1,is_admin_test:admin,status:'active',market:'1x2',outcome:'1',stake:10,price:2.1,payout:21,next_change_at:0}];
  const players=[{id:2,name:'Северная трибуна',quizzes:8,quiz_percent:80,predictions:15,prediction_percent:60,qualified:true},{id:1,name:'Твой ник',quizzes:6,quiz_percent:72,predictions:10,prediction_percent:80,qualified:false},{id:3,name:'Голос стадиона',quizzes:5,quiz_percent:75,predictions:12,prediction_percent:58,qualified:false},{id:4,name:'Новый игрок',quizzes:0,quiz_percent:null,predictions:0,prediction_percent:null,qualified:false}].sort((a,b)=>b.quizzes*(b.quiz_percent||0)-a.quizzes*(a.quiz_percent||0)||a.name.localeCompare(b.name,'ru')||a.id-b.id).map((p,i)=>({...p,rank:i+1}));

  if(state==='long')players[0].name="УчастникСОченьДлиннымНикомБезПробеловДляПроверкиПереноса";
  const transactions=[{id:3,type:"quiz_reward",amount:1,quiz:"Легенды футбола",created_at:now()-600},{id:2,type:"bet",amount:-10,match:"Арсенал — Интер",market:"1x2",outcome:"1",created_at:now()-86400},{id:1,type:"payout",amount:18,match:"Бавария — Бенфика",market:"1x2",outcome:"1",created_at:now()-86400*2}];
  const handlers = new Map();
  window.Telegram={WebApp:{initData:"local-demo-only",initDataUnsafe:{start_param:params.get('tab')||'quizzes'},get colorScheme(){return theme;},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},onEvent(name,fn){handlers.set(name,fn);},HapticFeedback:{notificationOccurred(){}}}};
  const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  window.fetch=async(input,options={})=>{
    const url=new URL(input,location.href),path=url.pathname;
    // Never fall through to a real API, even when a demo handler is missing.
    if(!path.startsWith('/api/'))return response({error:'Недоступно в демонстрации'},404);
    if(path==='/api/me')return response(profile());
    if(path==='/api/season')return response({season:{id:'2026-winter',name:'Зима 2026–2027',label:'Зима 26/27',starts_at:firstStart,ends_at:firstEnd,cutoff:firstEnd-604800,pending_start:pending(),activation_pending:true},qualified:!pending()&&balance>=100,threshold:100,frozen:false,rules:null,seasons:[{id:'2026-winter',label:'Зима 26/27'}]});
    if(path==='/api/finals')return response({items:[]});
    if(path==='/api/policy')return response({policy:null});
    if(path==='/api/preferences'){if(options.method==='PUT'){const b=JSON.parse(options.body);if(b.public_profile||b.public_avatar||b.marketing_opt_in)return response({error:'Публикация политики ожидает утверждения'},400);prefs={public_profile:false,public_avatar:false,marketing_opt_in:false,marketing_opt_out:Boolean(b.marketing_opt_out)};}return response(prefs);}
    if(path==='/api/requests'){if(options.method==='POST'){const b=JSON.parse(options.body);if(!b.message?.trim())return response({error:'Опишите обращение'},400);const r={...b,id:requests.length+1,status:'open'};requests.unshift(r);return response(r,201);}return response({items:requests});}
    if(state==='loading'&&!path.startsWith('/api/admin/'))return new Promise(()=>{});
    if(state==='error'&&!path.startsWith('/api/admin/'))return response({error:'Демонстрация ошибки сети. Попробуйте ещё раз.'},503);
    const body=options.body?JSON.parse(options.body):{};
    if(path==='/api/quiz')return response(quiz());
    const questionPath=/^\/api\/quiz\/questions\/(\d+)\/(open|answer)$/.exec(path);
    if(questionPath){const q=questions.find(q=>q.id===Number(questionPath[1]));if(!q)return response({error:'Вопрос не найден'},404);
      if(questionPath[2]==='open'){q.opened=true;q.text=texts[q.id];q.deadline=now()+20;}
      else {if(q.done)return response({error:'Ответ уже принят'},409);q.answer=body.answer;q.correct=q.answer.toLowerCase().includes(q.id===1?'ливерпул':'энфилд');q.done=true;q.attempts_left=0;if(q.correct)balance++;}
      return response({now:now(),question:q,correct:q.correct,balance});}
    if(path==='/api/quizzes/2')return response({title:'Легенды футбола',ended:true,questions:[{id:7,text:'Кто выиграл ЛЧ в 2005 году?',correct:true,answer:'Ливерпуль',answers:['Ливерпуль'],done:true}]});
    if(path==='/api/history')return response({items:state==='empty'?[]:transactions,next:null});
    if(path==='/api/leaderboard')return response({example:(state==='sample'||state==='long'),season:{id:'2026-winter',pending_start:pending()},qualification_frozen:false,sort:'quiz_rating_desc',total:state==='empty'||(pending()&&state!=='sample'&&state!=='long')?0:players.filter(p=>p.id!==1||prefs.public_profile).length,rows:state==='empty'||(pending()&&state!=='sample'&&state!=='long')?[]:players.filter(p=>p.id!==1||prefs.public_profile).map((p,i)=>({...p,rank:i+1})),me:state==='empty'?null:players.find(p=>p.id===1)});
    if(path==='/api/users/2')return response({...players.find(p=>p.id===2),photo_url:null});
    if(path==='/api/matches')return response({now:now(),tournaments:[{code:'CL',name:'Лига чемпионов'},{code:'PL',name:'АПЛ'}],matches:state==='empty'||url.searchParams.get('t')==='PL'?[]:[{...match,odds:odds['1x2']}]});
    if(path==='/api/matches/1')return response({...match,odds});
    if(path==='/api/predictions'&&options.method==='POST'){
      if(!admin&&!match.open)return response({error:'Приём прогнозов ещё не открыт'},409);
      const stake=body.stake;if(!Number.isInteger(stake)||stake<1||stake>100)return response({error:'Введите целую сумму от 1 до 100 BIST'},400);
      const previous=match.my[0];if(stake>balance+(previous?.stake||0))return response({error:'Недостаточно BIST'},409);
      balance+=previous?.stake||0;balance-=stake;
      match.my=[{id:1,is_admin_test:admin,status:'active',market:body.market,outcome:body.outcome,stake,price:odds[body.market][body.outcome],payout:stake*odds[body.market][body.outcome],next_change_at:0}];return response({balance,replaced:!!previous});}
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
