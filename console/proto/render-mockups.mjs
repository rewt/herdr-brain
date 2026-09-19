// Deterministic visual evidence. Run from any directory; writes only in this repo.
import fs from 'node:fs';
import {initialState,rowDetail} from './controller.mjs';
import {frame,plain} from './frame.mjs';
import {openItems,goals,tasks,sessions} from './model.mjs';
const root=new URL('../../',import.meta.url),folder=new URL('./snapshots/',import.meta.url);
fs.mkdirSync(folder,{recursive:true});
const marker='<!-- GENERATED MOCKUPS: node console/proto/render-mockups.mjs -->';
const doc=new URL('docs/design/console-screens-2026-09-18.md',root);
let text=fs.readFileSync(doc,'utf8').split(marker)[0].trimEnd()+`\n\n${marker}\n\n## Exact prototype renders\n\nThese are generated text frames, not hand-aligned approximations. Blank lines and clipped titles are intentional. Each source snapshot has exactly the requested number of rows; trailing spaces are omitted in Markdown. Interactive Ink uses the same frame and reserves one physical terminal line, as the current app does.\n`;
const baseline=initialState();
const scenarios=[
 ['overview','Overview: no goal or task picked',baseline,''],
 ['goal-picked','Overview: G-1 picked; tasks and open items narrow',{...baseline,goal:'G-1',cursor:{...baseline.cursor,goals:'G-1'}},' --goal G-1'],
 ['task-picked','Overview: G-1 and ENG-1 picked; two related questions',{...baseline,goal:'G-1',task:'ENG-1',cursor:{...baseline.cursor,goals:'G-1',tasks:'ENG-1'}},' --goal G-1 --task ENG-1'],
 ['waiting','Waiting detail',rowDetail(baseline,openItems[0]),' --screen waiting'],
 ['goal','Goal detail',rowDetail(baseline,goals[0]),' --screen goal'],
 ['task','Task detail',rowDetail(baseline,tasks[0]),' --screen task'],
 ['session','Session detail',rowDetail(baseline,sessions[0]),' --screen session']
];
for(const [name,title,s,args] of scenarios){text+=`\n### ${title}\n`;for(const [w,h] of [[80,30],[100,40],[140,45]]){const render=plain(frame(s,w,h));fs.writeFileSync(new URL(`${name}-${w}x${h}.txt`,folder),render);text+=`\n**${w}×${h}** — \`node console/proto/main.mjs --print ${w}x${h}${args}\`\n\n\`\`\`text\n${render}\`\`\`\n`;}}
fs.writeFileSync(doc,text);
process.stdout.write(`Generated ${scenarios.length*3} exact frames and the design document's mockup section.\n`);
