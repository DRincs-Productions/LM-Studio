import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.join(process.env.USERPROFILE,'.lmstudio');
const source=path.join(root,'apps','bionic','.internal','user-concrete-model-default-config','llmfan46','Qwen3.5-27B-Writer-V2-uncensored-heretic-GGUF','Qwen3.5-27B-Writer-V2-uncensored-heretic-Q4_K_M.gguf.json');
const template=JSON.parse(await fs.readFile(source,'utf8'));
const system=(await fs.readFile(path.join(root,'production-tests','writer-model-comparison','prompts','writer-system-optimized.txt'),'utf8')).trim();
const targets=[
  {modelKey:'hemmingway-1-abliterated-extreme', displayName:'Hemmingway1 Extreme', indexedModelIdentifier:'JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF/Hemmingway1-Extreme-Q4_K_M.gguf'},
  {modelKey:'qwen3.5-27b-writer-v2-uncensored-heretic', displayName:'Qwen3.5 27B Writer v2 Uncensored Heretic', indexedModelIdentifier:'llmfan46/Qwen3.5-27B-Writer-V2-uncensored-heretic-GGUF/Qwen3.5-27B-Writer-V2-uncensored-heretic-Q4_K_M.gguf'},
  {modelKey:'mistralai_mistral-small-3.2-24b-instruct-2506', displayName:'Mistral Small 3.2 24B Instruct Q4_K_M', indexedModelIdentifier:'bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF/mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf'}
];
for(const model of targets){
  const modelFile=path.join(root,'models',model.indexedModelIdentifier);
  await fs.access(modelFile);
  const configPath=path.join(root,'apps','bionic','.internal','user-concrete-model-default-config',model.indexedModelIdentifier+'.json');
  await fs.mkdir(path.dirname(configPath),{recursive:true});
  let cfg;
  try {
    cfg=JSON.parse(await fs.readFile(configPath,'utf8'));
    const backupDir=path.join(root,'production-tests','writer-model-comparison','candidate-config-backups');
    await fs.mkdir(backupDir,{recursive:true});
    await fs.copyFile(configPath,path.join(backupDir,model.modelKey.replace(/[^a-z0-9._-]/gi,'_')+'.json'));
  } catch(error) {
    if(error.code!=='ENOENT') throw error;
    cfg=structuredClone(template);
  }
  const fields=cfg.operation.fields;
  const set=(key,value)=>{const field=fields.find(x=>x.key===key); if(field) field.value=value; else fields.push({key,value});};
  set('llm.prediction.systemPrompt',system);
  set('llm.prediction.temperature',model.modelKey==='mistralai_mistral-small-3.2-24b-instruct-2506' ? 0.15 : 0.78);
  set('llm.prediction.repeatPenalty',{checked:true,value:1.02});
  const thinking=fields.find(field=>field.key==='llm.prediction.reasoning.enableThinking');
  if(model.modelKey!=='mistralai_mistral-small-3.2-24b-instruct-2506') {
    if(thinking) thinking.value=false; else fields.push({key:'llm.prediction.reasoning.enableThinking',value:false});
  } else {
    // This Llama-family comparator does not expose reasoning control in LM Studio.
    cfg.operation.fields=fields.filter(field=>field.key!=='llm.prediction.reasoning.enableThinking');
  }
  const temporary=configPath+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(cfg,null,2)+'\n','utf8');
  await fs.rename(temporary,configPath);
  process.stdout.write(`${model.displayName}\n${model.indexedModelIdentifier}\n${configPath}\n`);
}
