const assert=require('node:assert/strict');const {test}=require('node:test');
const {AzureLessonSummary}=require('../dist/modules/lesson-folders/azure-lesson-summary');
const {readEnvironment}=require('../dist/config/environment');
const config={azureOpenAI:{endpoint:'https://streamora-openai.openai.azure.com/openai/v1',apiKey:'test-key',deployment:'test-deployment'}};
test('Azure Responses adapter sends deployment, base instructions, optional prompt and inline documents without storing requests',async()=>{
 const previous=global.fetch;let request;
 global.fetch=async(url,init)=>{request={url,...init,body:JSON.parse(init.body)};return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({title:'Tóm tắt',markdown:'Nội dung',sourceIds:['file-id']})}]}]}));};
 try{const result=await new AzureLessonSummary(config).generate([{type:'input_text',text:'Transcript'},{type:'input_file',filename:'slide.pdf',file_data:'data:application/pdf;base64,JVBERg=='}],'Tập trung bài tập',new AbortController().signal);
 assert.equal(result.title,'Tóm tắt');assert.equal(request.url,config.azureOpenAI.endpoint+'/responses');assert.equal(request.body.model,'test-deployment');assert.equal(request.body.store,false);assert.match(request.body.instructions,/Không bịa/);assert.match(request.body.input[0].content[0].text,/Tập trung bài tập/);assert.equal(request.headers['api-key'],'test-key');assert.equal(request.body.text.format.type,'json_schema');
 }finally{global.fetch=previous;}
});
test('Azure errors and invalid output never leak raw provider errors or accept truncated results',async()=>{
 const previous=global.fetch;const ai=new AzureLessonSummary(config);
 try{
 global.fetch=async()=>new Response('private provider error',{status:429});await assert.rejects(()=>ai.generate([],'',new AbortController().signal),/AI_RATE_LIMITED/);
 global.fetch=async()=>new Response(JSON.stringify({status:'incomplete',output:[]}));await assert.rejects(()=>ai.generate([],'',new AbortController().signal),/AI_INCOMPLETE_OUTPUT/);
 global.fetch=async()=>new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:'{"title":0}'}]}]}));await assert.rejects(()=>ai.generate([],'',new AbortController().signal),/AI_INVALID_OUTPUT/);
 }finally{global.fetch=previous;}
});
test('Azure configuration validates resource endpoint and keeps optional integration disabled until configured',()=>{
 const base={NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/test',ACCESS_TOKEN_SECRET:'x'.repeat(48),FILES_CLEANUP_ENABLED:'false',IVS_ENABLED:'false'};
 assert.equal(readEnvironment(base).azureOpenAI,undefined);
 const input={...base,AZURE_OPENAI_ENDPOINT:'https://streamora-openai.openai.azure.com/',AZURE_OPENAI_API_KEY:'key',AZURE_OPENAI_DEPLOYMENT:'gpt-4.1-mini'};
 assert.equal(readEnvironment(input).azureOpenAI.endpoint,'https://streamora-openai.openai.azure.com/openai/v1');
 assert.throws(()=>readEnvironment({...input,AZURE_OPENAI_ENDPOINT:'https://evil.test'}),/AZURE_OPENAI_ENDPOINT/);
});
