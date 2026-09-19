import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,key,click,mouse,rowDetail,actions} from './controller.mjs';
import {frame,plain} from './frame.mjs';
import {counts,openItems,goals,tasks,sessions,lists,identity} from './model.mjs';
import {decoder} from './input.mjs';
import {cellWidth} from '../lib/text.mjs';
const press=(s,input='',k={})=>key(s,input,k,frame(s,80,30));
test('the fixture scale and cascade never reduce the global attention count',()=>{
 let s=initialState();assert.equal(goals.length,6);assert.equal(tasks.length,60);assert.equal(sessions.length,8);assert.equal(counts(s).needs,13);
 s=click(s,{type:'row',area:'goals',row:goals[0]});assert.equal(lists(s).tasks.length,11);
 s=click(s,{type:'row',area:'tasks',row:tasks[0]});assert.equal(lists(s).open.length,2);assert.equal(counts(s).needs,13);
 s=press(s,'!');assert.equal(lists(s).open.length,16);assert.equal(s.goal,null);
 s=press(s,'b');assert.equal(s.goal,'G-1');assert.equal(s.task,'ENG-1');
});
test('readers fit all target dimensions and a visible focus survives every width',()=>{
 for(const [w,h] of [[80,30],[100,40],[140,45]])for(const s of [initialState(),...[openItems[0],goals[0],tasks[0],sessions[0]].map(r=>rowDetail(initialState(),r))]){
  const f=frame(s,w,h);assert.equal(f.lines.length,h);for(const l of f.lines)assert.equal(cellWidth(l.spans.map(s=>s.text).join('')),w);
  assert.match(plain(f),/Needs you 13/);assert.match(plain(f),/Sessions/);assert.match(plain(f),/>/);assert.doesNotMatch(plain(f),/Task   n|Review launch/);
 }
 const narrow=plain(frame(rowDetail(initialState(),openItems[0]),80,30));for(const text of ['Why:','Your draft','Related:','[1]','recommended'])assert.ok(narrow.includes(text));
});
test('Enter opens detail; peek and related screens return to the exact source',()=>{
 let s=press(initialState(),'j');const cursor=s.cursor.open;s=press(s,'',{return:true});assert.equal(s.view,'detail');
 s=press(s,'',{return:true});assert.equal(s.view,'peek');s=press(s,'b');assert.equal(s.view,'detail');s=press(s,'b');assert.equal(s.cursor.open,cursor);
 let q=rowDetail(initialState(),openItems[0]);q=press(q,'G');assert.equal(q.detail.kind,'goal');q=press(q,'b');assert.equal(q.detail.id,'Q-1');
});
test('number and recommendation review before changing the in-memory inbox',()=>{
 let s=rowDetail(initialState(),openItems[0]);s=press(s,'y');assert.equal(s.view,'confirm');assert.equal(counts(s).needs,13);assert.equal(s.pending.option,'1');
 s=press(s,'b');assert.equal(counts(s).needs,13);s=press(press(s,'2'),'',{return:true});assert.equal(counts(s).needs,12);assert.match(s.message,/Demo only/);
});
test('draft editor owns typing, has a non-Esc cancel, and preserves the draft',()=>{
 let s=press(rowDetail(initialState(),openItems[0]),'r');s=press(s,' b!');assert.match(s.text,/ b!$/);
 s=press(s,'',{tab:true});s=press(s,'',{tab:true});s=press(s,'',{return:true});assert.equal(s.view,'detail');
 s=press(s,'r');assert.match(s.text,/ b!$/);s=click(s,{type:'cancel'});assert.equal(s.view,'detail');
});
test('mouse selects without opening; disclosure opens; wheel follows its region',()=>{
 let s=initialState(),f=frame(s,100,40);const hit=f.hits.find(h=>h.target.type==='row'&&h.target.area==='open'&&!h.target.open);
 s=mouse(s,{x:hit.x,y:hit.y,button:'left',press:true},f);assert.equal(s.view,'board');
 const open=f.hits.find(h=>h.target.type==='row'&&h.target.area==='open'&&h.target.open);s=mouse(s,{x:open.x,y:open.y,button:'left',press:true},f);assert.equal(s.view,'detail');
 s=press(s,'b');f=frame(s,100,40);const region=f.areas.find(a=>a.name==='tasks');s=mouse(s,{x:region.x,y:region.y+2,button:'wheelDown',press:true},f);assert.equal(s.focus,'tasks');assert.equal(s.task,'ENG-1');
});
test('all sessions remain selectable and visible in compact readers',()=>{
 let s=rowDetail(initialState(),openItems[0]);s=press(s,'s');
 for(const session of lists(s).sessions){s=click(s,{type:'row',area:'sessions',row:session});const f=frame(s,80,30);assert.ok(f.hits.some(h=>h.target.type==='row'&&h.target.area==='sessions'&&identity(h.target.row)===session.name));assert.match(plain(f),new RegExp('> '+session.name));}
});
test('fragmented and coalesced mouse reports never become numbered answers',()=>{
 const events=[],feed=decoder(e=>events.push(e));feed('\x1b[<0;');feed('',true);feed('50;6M\x1b[<0;50;6mj\x1b[B');
 assert.equal(events.length,4);assert.equal(events[0].mouse.x,49);assert.equal(events[1].mouse.press,false);assert.equal(events[2].input,'j');assert.ok(events[3].key.downArrow);
 feed('\x1b[200~b!1\nreply\x1b[201~');assert.ok(events.at(-1).key.paste);assert.equal(events.at(-1).input,'b!1 reply');
});
test('later can be found globally and returned to the inbox',()=>{
 let s=press(rowDetail(initialState(),openItems[0]),'l');assert.equal(counts(s).needs,12);assert.equal(counts(s).later,1);
 s=click(s,{type:'destination',view:'later'});assert.equal(lists(s).open.length,1);s=press(s,'',{return:true});s=press(s,'u');assert.equal(counts(s).needs,13);assert.equal(counts(s).later,0);
});
