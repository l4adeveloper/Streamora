const assert = require('node:assert/strict');
const {test,before,after}=require('node:test');
const {randomUUID}=require('node:crypto');
const {createMeetingFixture}=require('./meeting-fixture.cjs');
const {LessonFoldersService}=require('../dist/modules/lesson-folders/lesson-folders.service');
const {AzureLessonSummary,LESSON_SUMMARY_PROMPT}=require('../dist/modules/lesson-folders/azure-lesson-summary');
const {FileStorageService}=require('../dist/modules/files/file-storage.service');
let f,owner,viewer,outsider,group,storage,worker,ai;
before(async()=>{
 f=await createMeetingFixture();owner=await f.account('Host');viewer=await f.account('Học viên');outsider=await f.account('Người ngoài');
 group=await f.prisma.group.create({data:{name:'Lớp kiểm thử folder',ownerId:owner.id,members:{create:[{userId:owner.id,role:'OWNER'},{userId:viewer.id,role:'VIEWER'}]}}});
 storage=f.app.get(FileStorageService);worker=f.app.get(LessonFoldersService);ai=f.app.get(AzureLessonSummary);
 f.config.azureOpenAI={endpoint:'https://streamora-openai.openai.azure.com/openai/v1',apiKey:'test-only-key',deployment:'test-deployment'};
}, {timeout:90000});
after(async()=>{if(f)await f.cleanup();});
async function file({folderId=null,published=true,video=false,groupId=group.id}={}){
 const content='Tài liệu về cân bằng tải và hệ thống phân tán.';
 const key=`test/${randomUUID()}.txt`;
 await storage.writeText(key,content);
 return f.prisma.libraryFile.create({data:{groupId,folderId,name:video?'Buổi học.webm':'Tài liệu.txt',size:Buffer.byteLength(content),mimeType:video?'video/webm':'text/plain',source:video?'LOCAL_RECORDING':'DOCUMENT',status:'AVAILABLE',objectKey:key,createdBy:owner.id,isPublished:published}});
}
async function create(body={}){
 const res=await f.api(owner,'POST',`/groups/${group.id}/sessions`,{createLessonFolder:true,...body},randomUUID());
 assert.equal(res.status,201,JSON.stringify(res.body));return res.body.session;
}
async function ended(folder){await f.prisma.classSession.update({where:{id:folder.sessionId},data:{status:'ENDED',startedAt:new Date(),endedAt:new Date()}});}
test('Creation is atomic and idempotent; each lesson has its own typed folder and selected files',async()=>{
 const material=await file();const key=randomUUID();const body={title:'Buổi 1',createLessonFolder:true,materialFileIds:[material.id]};
 const a=await f.api(owner,'POST',`/groups/${group.id}/sessions`,body,key);
 const b=await f.api(owner,'POST',`/groups/${group.id}/sessions`,body,key);
 assert.equal(a.status,201);assert.deepEqual(a.body,b.body);const s=a.body.session;
 assert.ok(s.lessonFolderId);assert.equal(await f.prisma.folder.count({where:{sessionId:s.id}}),1);
 assert.equal((await f.prisma.libraryFile.findUnique({where:{id:material.id}})).folderId,s.lessonFolderId);
 const folders=await f.api(viewer,'GET',`/groups/${group.id}/folders`);const folder=folders.body.folders.find(x=>x.id===s.lessonFolderId);
 assert.equal(folder.kind,'LESSON');assert.equal(folder.sessionId,s.id);
 const details=await f.api(owner,'GET',`/sessions/${s.id}`);assert.equal(details.body.session.lessonFolderId,s.lessonFolderId);
 const b2=await create({title:'Buổi 1'});assert.notEqual(b2.lessonFolderId,s.lessonFolderId);
 const docs=await f.api(owner,'GET',`/groups/${group.id}/files?sessionId=${s.id}&limit=100`);assert.ok(docs.body.items.some(x=>x.id===material.id));
});
test('Create without folder remains supported; rejects forged cross-group files and viewers',async()=>{
 const otherGroup=await f.prisma.group.create({data:{name:'Nhóm khác',ownerId:outsider.id}});
 const foreign=await file({groupId:otherGroup.id});const before=await f.prisma.classSession.count();
 const invalid=await f.api(owner,'POST',`/groups/${group.id}/sessions`,{createLessonFolder:true,materialFileIds:[foreign.id]},randomUUID());
 assert.equal(invalid.status,403);assert.equal(await f.prisma.classSession.count(),before);
 assert.equal((await f.api(viewer,'POST',`/groups/${group.id}/sessions`,{createLessonFolder:true})).status,403);
 const old=await f.api(owner,'POST',`/groups/${group.id}/sessions`,{title:'Không có folder'},randomUUID());
 assert.equal(old.status,201);assert.equal(old.body.session.lessonFolderId,null);
 assert.equal((await f.api(owner,'POST',`/groups/${group.id}/sessions`,{createLessonFolder:false,materialFileIds:[foreign.id]})).status,400);
});
test('Materials added later stay in the exact folder; active lesson folders cannot be deleted',async()=>{
 const s=await create({scheduledAt:new Date(Date.now()+3600000).toISOString()});const doc=await file();
 const add=await f.api(owner,'POST',`/folders/${s.lessonFolderId}/materials`,{fileIds:[doc.id]});assert.equal(add.status,200);
 assert.equal((await f.prisma.libraryFile.findUnique({where:{id:doc.id}})).folderId,s.lessonFolderId);
 assert.equal((await f.api(viewer,'POST',`/folders/${s.lessonFolderId}/materials`,{fileIds:[doc.id]})).status,403);
 assert.equal((await f.api(outsider,'GET',`/folders/${s.lessonFolderId}/summary`)).status,403);
 assert.equal((await f.api(owner,'DELETE',`/folders/${s.lessonFolderId}`)).status,409);
});
test('Recording completion routes the file into the lesson folder even after lesson end and rename',async()=>{
 const s=await create();await f.api(owner,'POST',`/sessions/${s.id}/start`,{},randomUUID());
 const enter=await f.api(owner,'POST',`/sessions/${s.id}/enter`,{},randomUUID());assert.equal(enter.status,200,JSON.stringify(enter.body));
 const record=await f.api(owner,'POST',`/sessions/${s.id}/recordings`,{participationId:enter.body.participation.id});assert.equal(record.status,200,JSON.stringify(record.body));
 const recordingId=record.body.recording.id;
 const video=await file({video:true});await f.prisma.libraryFile.update({where:{id:video.id},data:{sessionId:s.id}});
 await f.api(owner,'PATCH',`/folders/${s.lessonFolderId}`,{name:'Đã đổi tên folder'});
 await f.api(owner,'POST',`/sessions/${s.id}/end`,{},randomUUID());
 const complete=await f.api(owner,'POST',`/sessions/${s.id}/recordings/${recordingId}/complete`,{fileId:video.id});
 assert.equal(complete.status,200,JSON.stringify(complete.body));
 assert.equal((await f.prisma.libraryFile.findUnique({where:{id:video.id}})).folderId,s.lessonFolderId);
 assert.equal((await f.api(owner,'POST',`/sessions/${s.id}/recordings/${recordingId}/complete`,{fileId:video.id})).status,200);
});
test('Summary uses transcript + documents + custom prompt, deduplicates, stores Markdown in its own folder, protects drafts',async()=>{
 const s=await create();const folder=await f.prisma.folder.findUnique({where:{id:s.lessonFolderId}});await ended(folder);
 const material=await file({folderId:folder.id,published:false}),video=await file({folderId:folder.id,video:true});
 await f.prisma.videoTranscript.create({data:{fileId:video.id,transcriptStatus:'READY',transcriptCues:[{startMs:0,endMs:5000,text:'Bài tập là thiết kế hệ thống cân bằng tải.'}]}});
 let calls=0;ai.generate=async(parts,prompt)=>{calls++;assert.equal(prompt,'Tập trung bài tập');assert.ok(parts.some(p=>p.text?.includes('Bài tập là')));assert.ok(parts.some(p=>p.text?.includes('Tài liệu về')));return {title:'Buổi học',markdown:'## Bài tập\nThiết kế hệ thống cân bằng tải.',sourceIds:[material.id,video.id]};};
 const request=()=>f.api(owner,'POST',`/folders/${folder.id}/summary`,{customPrompt:'Tập trung bài tập'});
 const first=await request();assert.equal(first.status,202,JSON.stringify(first.body));const job=first.body.summary.id;
 assert.equal((await request()).body.summary.id,job);
 assert.equal((await f.api(viewer,'POST',`/folders/${folder.id}/summary`,{})).status,403);
 await worker.tick();
 const result=await f.api(owner,'GET',`/folders/${folder.id}/summary`);assert.equal(result.body.summary.status,'READY',JSON.stringify(result.body));
 const output=await f.prisma.libraryFile.findUnique({where:{id:result.body.summary.resultFileId}});
 assert.equal(output.folderId,folder.id);assert.equal(output.sessionId,s.id);assert.equal(output.isPublished,false);
 const stream=await storage.read(output.objectKey,output.storageLocationId);let markdown='';for await(const chunk of stream)markdown+=chunk;
 assert.match(markdown,/Thiết kế hệ thống/);assert.equal((await request()).body.summary.id,job);assert.equal(calls,1);
 assert.equal((await f.api(viewer,'GET',`/folders/${folder.id}/summary`)).body.summary,null);
 assert.equal((await f.api(viewer,'POST',`/files/${output.id}/download-url`,{})).status,403);
 await f.prisma.libraryFile.update({where:{id:material.id},data:{isPublished:true}});
 ai.generate=async()=>({title:'Bản mới',markdown:'Tóm tắt mới',sourceIds:[material.id]});
 const next=await request();assert.notEqual(next.body.summary.id,job);await worker.tick();
 assert.equal((await f.api(viewer,'GET',`/folders/${folder.id}/summary`)).body.summary.status,'READY');
});
test('Summary rejects live lessons, pending transcripts, unsupported files and forged extra fields',async()=>{
 const s=await create();const folder=await f.prisma.folder.findUnique({where:{id:s.lessonFolderId}});
 assert.equal((await f.api(owner,'POST',`/folders/${folder.id}/summary`,{})).status,409);
 await ended(folder);const video=await file({folderId:folder.id,video:true});
 const pending=await f.api(owner,'POST',`/folders/${folder.id}/summary`,{});assert.equal(pending.status,409);assert.equal(pending.body.error.code,'TRANSCRIPT_NOT_READY');
 await f.prisma.libraryFile.update({where:{id:video.id},data:{mimeType:'application/octet-stream'}});
 assert.equal((await f.api(owner,'POST',`/folders/${folder.id}/summary`,{})).status,415);
 assert.equal((await f.api(owner,'POST',`/folders/${folder.id}/summary`,{customPrompt:'x'.repeat(4001)})).status,400);
 assert.equal((await f.api(owner,'POST',`/folders/${folder.id}/summary`,{endpoint:'https://evil.test'})).status,400);
});
test('Worker rejects changed sources and invalid model source IDs without saving a result',async()=>{
 const s=await create();const folder=await f.prisma.folder.findUnique({where:{id:s.lessonFolderId}});await ended(folder);const doc=await file({folderId:folder.id});
 let response=await f.api(owner,'POST',`/folders/${folder.id}/summary`,{});assert.equal(response.status,202);
 await f.prisma.libraryFile.update({where:{id:doc.id},data:{name:'Đã đổi nguồn'}});await worker.tick();
 let state=await f.api(owner,'GET',`/folders/${folder.id}/summary`);assert.equal(state.body.summary.status,'FAILED');assert.equal(state.body.summary.errorCode,'SUMMARY_SOURCES_CHANGED');
 ai.generate=async()=>({title:'Sai nguồn',markdown:'Nội dung',sourceIds:[randomUUID()]});
 response=await f.api(owner,'POST',`/folders/${folder.id}/summary`,{});await worker.tick();
 state=await f.api(owner,'GET',`/folders/${folder.id}/summary`);assert.equal(state.body.summary.status,'FAILED');assert.equal(state.body.summary.errorCode,'AI_INVALID_OUTPUT');
 assert.equal(await f.prisma.lessonSummary.count({where:{folderId:folder.id,resultFileId:{not:null}}}),0);
 assert.match(LESSON_SUMMARY_PROMPT,/Không bịa/);
});
test('Concurrent requests share one job, and the worker never sends sources after host access is revoked',async()=>{
 const s=await create();const folder=await f.prisma.folder.findUnique({where:{id:s.lessonFolderId}});await ended(folder);await file({folderId:folder.id});
 const requests=await Promise.all([1,2].map(()=>f.api(owner,'POST',`/folders/${folder.id}/summary`,{customPrompt:'So sánh kiến thức'})));
 assert.equal(requests[0].status,202);assert.equal(requests[1].status,202);assert.equal(requests[0].body.summary.id,requests[1].body.summary.id);
 assert.equal((await f.api(owner,'POST',`/folders/${folder.id}/summary`,{customPrompt:'Yêu cầu khác'})).status,409);
 assert.equal((await f.api(owner,'DELETE',`/folders/${folder.id}`)).status,409);
 let called=false;ai.generate=async()=>{called=true;throw Error('should not call');};
 await f.prisma.user.update({where:{id:owner.id},data:{disabledAt:new Date()}});
 try{await worker.tick();const job=await f.prisma.lessonSummary.findUnique({where:{id:requests[0].body.summary.id}});assert.equal(job.status,'FAILED');assert.equal(job.errorCode,'SUMMARY_ACCESS_REVOKED');assert.equal(called,false);}
 finally{await f.prisma.user.update({where:{id:owner.id},data:{disabledAt:null}});}
});
