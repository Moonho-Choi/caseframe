import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editMetadata, resultKey, validateProject } from '../js/project.js';
import { pickSmooth } from '../js/select.js';

const settings = {quality:'none',step:'2',title:'검사',labelMode:'date',vshift:'0',hshift:'0',crop:'0'};
const photo = (no = 1) => ({name:`photo${no}.jpg`,no,date:new Date(2025,0,no),T:[1,0,0,0,1,0]});
const project = () => ({format:'caseframe-motion',version:1,reference:'',settings:{...settings},items:[{...editMetadata(photo()),png:'data:image/png;base64,AAAA'}]});

test('saving a result becomes stale after title, crop, transform, or inclusion changes', () => {
  const items = [photo(1),photo(2)];
  const key = resultKey(items,settings,'');
  for (const changes of [{title:'새 제목'},{crop:'5'},{step:'3'}]) assert.notEqual(resultKey(items,{...settings,...changes},''),key);
  assert.notEqual(resultKey(items,settings,'2'),key);
  assert.notEqual(resultKey([items[0],{...items[1],excluded:true}],settings,''),key);
  assert.notEqual(resultKey([items[0],{...items[1],adjust:{scale:1,rotation:0,dx:2,dy:0}}],settings,''),key);
  assert.equal(resultKey(items.map(it => ({...it,protected:true})),settings,''),key);
  assert.notEqual(resultKey([{...photo(),original:{}}],settings,''),resultKey([{...photo(),original:{}}],settings,''),'same filename from another project must not reuse a prior video');
});
test('protected intermediate milestone remains even with poor overlap', () => {
  const result = pickSmooth(7,() => .1,.8,3,new Set([2,4]));
  assert.ok(result.includes(2)); assert.ok(result.includes(4));
  assert.equal(result[0],0); assert.equal(result.at(-1),6);
  assert.deepEqual(result,[...new Set(result)].sort((a,b)=>a-b));
});
test('project metadata validation rejects malformed or incompatible work before loading images', () => {
  assert.equal(validateProject(project()).version,1);
  const mutations = [
    p=>p.version=2, p=>p.items=[], p=>p.settings.step='NaN', p=>p.settings.crop='50',
    p=>p.items[0].T=[0,0,0,0,0,0], p=>p.items[0].date=Infinity,
    p=>p.items[0].png='https://example.com/private.jpg', p=>p.reference='50',
    p=>p.items.push({...p.items[0]}), p=>p.items[0].adjust.dx=Infinity,
    p=>{p.items[0].protected=true;p.items[0].excluded=true;}
  ];
  for (const mutate of mutations) { const p=project(); mutate(p); assert.throws(()=>validateProject(p)); }
});
