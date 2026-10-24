import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createAppHarness} from '../tests/helpers/app-harness.js';
import http from 'node:http';
const dir=new URL('../.diagnostics/audit-layout/',import.meta.url);
mkdirSync(dir,{recursive:true});
const app=await createAppHarness({beforeStart:async({db,storage})=>{
 const id=await db.saveFitnessPlan({name:'推日计划',exercises:[{name:'坐姿哑铃肩上推举',muscle_group:'肩部',notes:'控制下放，避免耸肩',recommended_sets:3,recommended_reps_min:8,recommended_reps_max:12,recommended_weight:12.5,recommended_rir:2,rest_seconds:90}]});
 storage.set('zuocai.activeWorkoutSession',await db.startWorkout(id));
 await db.saveTask({title:'核对一份非常长的实验报告标题以及统计数据，确保操作按钮在手机窄屏幕下仍位于卡片内部',estimated_minutes:60,importance:'high',tags:[],plans:[{plan_date:'2026-10-01'}]});
}});
await app.submit({reps:10,weight:12.5,rir:2});
const css=['styles.css','schedule-fixes.css','workout-focus.css'].map(name=>readFileSync(new URL(`../src/${name}`,import.meta.url),'utf8')).join('\n');
const html=app.document.documentElement.outerHTML;
const create=(page)=>{
 let doc=html.replace(/<script[\s\S]*?<\/script>/g,'').replace('</head>',`<style>${css}</style></head>`);
 if(page!=='training')doc=doc.replace('id="workout-dialog" open','id="workout-dialog"').replace(' open=""','');
 if(page==='settings')doc=doc.replace('class="page active" data-page="today"','class="page" data-page="today"').replace('class="page" data-page="settings"','class="page active" data-page="settings"');
 if(page==='schedule')doc=doc.replace('class="page active" data-page="today"','class="page" data-page="today"').replace('class="page" data-page="schedule"','class="page active" data-page="schedule"');
 if(page==='training')doc=doc.replace('</body>','<script>document.querySelector("#workout-dialog").removeAttribute("open");document.querySelector("#workout-dialog").showModal();</script></body>');
 return doc;
};
for(const page of ['today','settings','schedule','training'])writeFileSync(new URL(`${page}.html`,dir),create(page));
app.dispose();
http.createServer((req,res)=>{
 const page=(req.url||'/').replace(/^\//,'').split('?')[0]||'today.html';
 if(!['today.html','settings.html','schedule.html','training.html'].includes(page)){res.writeHead(404);res.end();return}
 res.setHeader('Content-Type','text/html;charset=utf-8');res.end(readFileSync(new URL(page,dir)));
}).listen(4173,'127.0.0.1',()=>console.log('本地布局验收样本已启动；仅含虚构测试数据。'));
