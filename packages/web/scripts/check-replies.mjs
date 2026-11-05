// Run against the web dev server on port 5199. API responses are isolated fixtures.
// npm run dev -w @piomio/web -- --host 127.0.0.1 --port 5199
import { chromium, expect } from '@playwright/test';
const base = process.env.PIOMIO_WEB_TEST_URL ?? 'http://127.0.0.1:5199';
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const iso = i => new Date(Date.UTC(2026,0,1,0,i)).toISOString();
const message = (id, role, text, i) => ({id,role,parts:[{type:'text',text}],status:'complete',conversationId:'c',...(role==='assistant'?{agentId:'assistant'}:{}),createdAt:iso(i)});
const agent = {id:'assistant',name:'Assistant',brains:['fake@local'],description:'Test',initiative:1};
try {
for (const mobile of [false,true]) {
 const page = await browser.newPage({ viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile });
 page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.stack));
 const original=message('old','assistant','Older original',0);
 const recent=Array.from({length:60},(_,i)=>message('m'+i,i%2?'user':'assistant','Message '+i,i+1));
 recent[59].parts.unshift({type:'reply_to',messageId:'old',text:'Older original',author:'Assistant'});
 let sent, fail=false;
 await page.route('**/api/**',async route=>{
  const req=route.request(), u=new URL(req.url());let data=[]; let status=200;
  if(u.pathname==='/api/auth/state') data={hasPassword:true,authenticated:true,passkeys:0,version:'test',language:'en'};
  else if(u.pathname==='/api/bootstrap') data={csrf:'t',version:'test',publicUrl:'http://127.0.0.1:5199',consoleUrl:'',mainConversationId:'c',defaultAgent:'assistant',language:'en',locales:['en','ru'],timezone:'UTC',vaultState:'unlocked',uiPlugins:[],channels:[],pendingApprovals:0};
  else if(u.pathname==='/api/conversations') data=[{id:'c',kind:'chat',title:'Replies',agentId:'assistant',createdAt:iso(0),updatedAt:iso(60)}];
  else if(u.pathname.includes('thinking')) data={agentId:'assistant',kinds:[],brains:[]};
  else if(u.pathname==='/api/agents') data=[agent];
  else if(u.pathname==='/api/setup') data={usable:true,starting:false,brains:[]};
  else if(u.pathname==='/api/conversations/c/messages') {
    if(req.method()==='POST') {sent=req.postDataJSON();if(fail){status=500;data={error:'Try again'};}else data={...message('sent','user',sent.text,62),parts:[...(sent.replyTo?[{type:'reply_to',messageId:sent.replyTo,text:sent.replyTo==='m58'?'Message 58':'Message 59',author:sent.replyTo==='m58'?'Assistant':'User'}]:[]),{type:'text',text:sent.text}]};}
    else data=u.searchParams.has('before')?[original]:recent;
  }
  await route.fulfill({status,json:data});
 });
 await page.goto(base+'/'+(mobile?'m/':'')+'chat/c');
 await expect(page.locator('[data-message-id="m59"]')).toBeVisible();
 await page.locator('[data-message-id="m58"]').getByRole('button',{name:'Reply',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'Reply to Assistant'})).toBeVisible();
 await page.getByRole('button',{name:'Cancel reply',exact:true}).click();
 await expect(page.getByRole('button',{name:'Cancel reply',exact:true})).toHaveCount(0);
 await page.locator('[data-message-id="m59"]').getByRole('button',{name:'Reply',exact:true}).click();
 const input=page.getByRole('textbox',{name:'Message',exact:true});
 await input.fill('My reply');fail=true;
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(input).toHaveValue('My reply');
 await expect(page.getByRole('button',{name:'Cancel reply',exact:true})).toBeVisible();
 await page.getByRole('alert').getByRole('button',{name:'Close',exact:true}).click();
 fail=false; await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByRole('button',{name:'Cancel reply',exact:true})).toHaveCount(0);
 expect(sent).toEqual({text:'My reply',replyTo:'m59'});
 await expect(page.locator('[data-message-id="sent"]')).toBeVisible();
 await page.locator('[data-message-id="m59"]').locator('button[title="Show original message"]').click();
 await expect(page.locator('[data-message-id="old"]')).toBeInViewport();
 if (process.env.PIOMIO_REPLY_SCREENSHOTS) await page.screenshot({path:`${process.env.PIOMIO_REPLY_SCREENSHOTS}/reply-${mobile?'mobile':'desktop'}.png`});
 expect(errors).toEqual([]);
 console.log(mobile?'mobile: passed':'desktop: passed');
 await page.close();
}
} finally { await browser.close(); }
