const path=require('path');
require('dotenv').config();
const express=require('express');
const multer=require('multer');
const pdfParse=require('pdf-parse');

const app=express();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024}});

const ISSUES=['Entrapment','Door Issue','Mechanical Failure','Power Outage','Inspection Issue','Noise/Vibration','Other'];
const STATS=['Open','In Progress','Resolved'];
const OPENAI_MODEL=process.env.OPENAI_MODEL||'gpt-4o-mini';

const AI_SYSTEM_PROMPT=`You are an assistant that extracts elevator incident data from security report PDFs.
Return ONLY a valid JSON object with these exact keys — no markdown, no explanation:

{
  "date": "YYYY-MM-DD — use the FIRST date found in the document, no exceptions",
  "building": "For Incident Reports use the Client field value. For Elevator Call Logs use the LOCATION OF THE PROBLEM field value.",
  "elevator": "Format: 'Elevator X'. Source is the CAB # field. If CAB # is a letter A-Z, use it directly. If CAB # is a number 1-26, map it: 1=A,2=B,3=C,4=D,5=E,6=F,7=G,8=H,9=I,10=J,11=K,12=L,13=M,14=N,15=O,16=P,17=Q,18=R,19=S,20=T,21=U,22=V,23=W,24=X,25=Y,26=Z",
  "issue_type": "One of: Entrapment, Door Issue, Mechanical Failure, Power Outage, Inspection Issue, Noise/Vibration, Other. RULE: if document title contains 'Incident Report' the value is ALWAYS Entrapment. If document is an Elevator Call Log, determine from description.",
  "status": "Open, In Progress, or Resolved. Incident Report: Open if elevator still out of service or repair pending overnight; Resolved if occupant released and elevator cleared same day. Call Log: Resolved if technician name and actual arrival time are both present; otherwise Open.",
  "description": "2-3 sentences in plain English. MUST include: (1) elevator identifier e.g. Elevator G or Service Elevator Cab #10, (2) any reference/service ticket number found in the document e.g. KONE service ticket #17542681, (3) concise factual summary of what happened.",
  "resolution_notes": "1-2 sentences summarizing actions taken or technician findings. Include technician name if present."
}`;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ── Text helpers ──────────────────────────────────────────────────────────────

function normText(text){
  return String(text||'')
    .replace(/\r/g,'')
    .split('\n')
    .map(l=>l.replace(/\s+/g,' ').trim())
    .filter(Boolean)
    .join('\n');
}

function normalizeDate(raw){
  if(!raw)return '';
  const s=String(raw).replace(/\./g,'/').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  // MM/DD/YYYY or MM/DD/YY
  const slash=s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if(slash){
    const mo=slash[1].padStart(2,'0'),d=slash[2].padStart(2,'0');
    const yr=slash[3].length===2?`20${slash[3]}`:slash[3];
    return `${yr}-${mo}-${d}`;
  }
  const p=new Date(s);
  return isNaN(p.getTime())?'':p.toISOString().slice(0,10);
}

function getFirstDate(text){
  // Strip revision stamps like "WN07052022" or "(Rev 02/22/2022)" before scanning
  const cleaned=text
    .replace(/\bWN\d{6,8}\b/gi,'')
    .replace(/\(Rev\s+\d{1,2}\/\d{1,2}\/\d{2,4}\)/gi,'');
  const mo='jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const rx=new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{4}\\b|\\b(?:${mo})\\s+\\d{1,2},?\\s+\\d{4}\\b`,'ig');
  for(const m of cleaned.matchAll(rx)){
    const d=normalizeDate(m[0]);
    if(d)return d;
  }
  return '';
}

function findOptionMatch(raw,options){
  if(!raw)return '';
  const l=String(raw).toLowerCase();
  return options.find(o=>l.includes(o.toLowerCase()))||'';
}

function extractCab(text){
  // Priority order: explicit form fields first, then inline patterns
  const patterns=[
    /\bCAB\s*#\s*[:\-]?\s*([A-Z])\b/i,          // CAB #: G  (letter)
    /\bCAB\s*#?\s*[:\-]\s*([A-Z])\b/i,
    /\bCAB\s*#\s*[:\-]?\s*(\d{1,2})\b/i,          // CAB #: 10 (number)
    /\bCAB\s*#?\s*[:\-]\s*(\d{1,2})\b/i,
    /Service\s+Elevator\s+Cab\s*#\s*(\d{1,2})/i,  // Service Elevator Cab #10
    /Elevator\s+Cab\s*#\s*(\d{1,2})/i,
  ];
  for(const rx of patterns){
    const m=text.match(rx);
    if(m)return m[1].trim().toUpperCase();
  }
  // Last resort: "Elevator G" anywhere
  const inline=text.match(/\bElevator\s+([A-Z])\b/i);
  return inline?inline[1].toUpperCase():'';
}

function cabToElevator(raw){
  if(!raw)return '';
  const up=String(raw).toUpperCase().trim();
  // Single letter A-Z → keep as letter
  if(/^[A-Z]$/.test(up))return `Elevator ${up}`;
  // Number 1-26 → keep as number (dropdown includes 1-26)
  const n=parseInt(up,10);
  if(!isNaN(n)&&n>=1&&n<=26)return `Elevator ${n}`;
  return '';
}

function extractLocation(text){
  const m=text.match(/(?:^|\n)LOCATION\s+OF\s+THE\s+PROBLEM\s*[:\-]\s*(.+)/im);
  return m?m[1].trim():'';
}

function extractClient(text){
  const m=text.match(/\bClient\s*[:\-]\s*(.+)/i);
  return m?m[1].trim():'';
}

function extractReference(text){
  const patterns=[
    /service\s+(?:ticket\s+)?reference\s*(?:number\s*)?#?\s*([A-Z0-9]{5,})/i,
    /reference\s+number\s*#?\s*([A-Z0-9]{5,})/i,
    /ticket\s*#\s*([A-Z0-9]{5,})/i,
    /#\s*([0-9]{5,})/,
  ];
  for(const rx of patterns){
    const m=text.match(rx);
    if(m)return `#${m[1].replace(/^#/,'')}`;
  }
  return '';
}

function inferIssue(text){
  const l=text.toLowerCase();
  if(/mechanical|motor|gear|brake|break\s+switch|controller|out\s+of\s+service|adjust/i.test(l))return 'Mechanical Failure';
  if(/no\s+entrap|no\s+one\s+trapped|no\s+passenger\s+trapped/.test(l))return 'Mechanical Failure';
  if(/entrap|trapp?ed|stuck\s+inside|code\s+gold/i.test(l))return 'Entrapment';
  if(/door|closing|opening|sensor/i.test(l))return 'Door Issue';
  if(/power|outage|blackout|electric/i.test(l))return 'Power Outage';
  if(/inspection|violation|code/i.test(l))return 'Inspection Issue';
  if(/noise|vibration|rattle|shaking/i.test(l))return 'Noise/Vibration';
  return 'Other';
}

function inferStatus(text,type){
  if(type==='incident_report'){
    if(/out\s+of\s+service\s+for\s+the\s+night|will\s+come\s+out\s+to\s+repair|repair\s+pending/i.test(text))return 'Open';
    if(/released|cleared\s+the\s+code\s+gold|returned\s+to\s+service/i.test(text))return 'Resolved';
    return 'Open';
  }
  // Call log: resolved when tech name + actual arrival both present
  const hasTech=/FULL\s+NAME\s+OF\s+THE\s+ELEVATOR\s+TECHNICIAN\s*[:\-]\s*[A-Za-z]{2,}/i.test(text);
  const hasArrival=/ACTUAL\s+TIME\s+OF\s+ARRIVAL\s*[:\-]\s*[^\n]{2,}/i.test(text);
  return hasTech&&hasArrival?'Resolved':'Open';
}

function detectType(text){
  if(/ELEVATOR\s+CALL\s+LOG/i.test(text))return 'call_log';
  if(/Incident\s+Report/i.test(text))return 'incident_report';
  return 'generic';
}

function buildSummary(text,elevator,reference){
  const sentences=text
    .split(/(?<=[.!?])\s+/)
    .map(s=>s.replace(/\s+/g,' ').trim())
    .filter(s=>s.length>20&&/(elevator|cab|stuck|entrap|service|repair|kone|floor|released|out\s+of\s+service)/i.test(s));
  let summary=sentences.slice(0,3).join(' ')||`Elevator incident reported. See attached PDF for full details.`;
  if(elevator&&!new RegExp(`\\bElevator\\s+${elevator.replace('Elevator ','')}`,'i').test(summary)){
    summary=`${elevator} incident. ${summary}`;
  }
  if(reference&&!summary.includes(reference)){
    summary=`${summary} Reference: ${reference}.`;
  }
  return summary.replace(/\s+/g,' ').trim();
}

// ── Local fallback parser ─────────────────────────────────────────────────────

function parseLocal(text){
  const type=detectType(text);
  const cab=extractCab(text);
  const elevator=cabToElevator(cab)||'Elevator 1';
  const reference=extractReference(text);
  const date=getFirstDate(text)||new Date().toISOString().slice(0,10);

  let building,issue,status,description,notes;

  if(type==='incident_report'){
    building=extractLocation(text)||extractClient(text)||'Unknown Location';
    issue='Entrapment';
    status=inferStatus(text,'incident_report');
    const descBlock=text.match(/Description\s+of\s+Incident[^)]*\)\s*\n?([\s\S]+?)(?=Action|Emergency|Security\s+Officer)/i)?.[1]||'';
    description=buildSummary(descBlock||text,elevator,reference);
    const notesBlock=text.match(/Action\(s\)\s+Taken\s*\n?([\s\S]+?)(?=Emergency|Security\s+Officer|Police)/i)?.[1]||'';
    notes=notesBlock.replace(/\s+/g,' ').trim().slice(0,300)||'No additional notes provided.';
  } else if(type==='call_log'){
    building=extractLocation(text)||'Unknown Location';
    issue=inferIssue(text);
    status=inferStatus(text,'call_log');
    const descBlock=text.match(/DESCRIPTION\s+OF\s+THE\s+PROBLEM\s*[:\-]?\s*\n?([\s\S]+?)(?=ANYONE\s+TRAPPED|INJURIES|TIME\s+ELEVATOR)/i)?.[1]||'';
    description=buildSummary(descBlock||text,elevator,reference);
    const techBlock=text.match(/ELEVATOR\s+TECHNICIAN\s+SHOULD\s+ANSWER[^:]*:([\s\S]+?)(?=WN\d|$)/i)?.[1]||'';
    notes=techBlock.replace(/\s+/g,' ').trim().slice(0,300)||'No additional notes provided.';
  } else {
    building=extractLocation(text)||extractClient(text)||'Unknown Location';
    issue=inferIssue(text);
    status='Open';
    description=buildSummary(text,elevator,reference);
    notes='No additional notes provided.';
  }

  console.log(`[local-parser] type=${type} cab=${cab} elevator=${elevator} issue=${issue} status=${status}`);

  return {date,building,location:building,elevator,issue,status,description,notes,reference:reference||'N/A'};
}

// ── OpenAI call with retry ────────────────────────────────────────────────────

async function callOpenAI(text){
  const apiKey=(process.env.OPENAI_API_KEY||'').trim();
  if(!apiKey)throw new Error('missing_key');

  const payload={
    model:OPENAI_MODEL,
    max_tokens:800,
    temperature:0,
    response_format:{type:'json_object'},
    messages:[
      {role:'system',content:AI_SYSTEM_PROMPT},
      {role:'user',content:text.slice(0,6000)}
    ]
  };

  for(let attempt=0;attempt<3;attempt++){
    const res=await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},
      body:JSON.stringify(payload)
    });
    if(res.ok){
      const data=await res.json();
      const raw=(data.choices?.[0]?.message?.content||'').trim();
      if(!raw)throw new Error('openai_empty');
      try{return JSON.parse(raw)}catch{
        const s=raw.indexOf('{'),e=raw.lastIndexOf('}');
        if(s<0||e<=s)throw new Error('openai_json_missing');
        return JSON.parse(raw.slice(s,e+1));
      }
    }
    if(res.status===429&&attempt<2){await sleep((attempt+1)*1500);continue;}
    throw new Error(`openai_${res.status}`);
  }
  throw new Error('openai_429_exhausted');
}

// ── Merge AI result with local extraction ─────────────────────────────────────

function mergeWithLocal(aiResult,text){
  const local=parseLocal(text);
  const ai=aiResult||{};

  // Prefer AI for description/notes; prefer local CAB-derived elevator; take first non-empty for everything else
  const pick=(a,b)=>(String(a||'').trim()||String(b||'').trim());

  // Elevator: always re-derive from CAB in raw text for reliability
  const cab=extractCab(text);
  const elevator=cabToElevator(cab)||pick(ai.elevator,local.elevator)||'Elevator 1';

  // Issue: Incident Report is always Entrapment regardless of AI
  const type=detectType(text);
  const aiIssue=findOptionMatch(ai.issue_type,ISSUES)||'';
  const issue=type==='incident_report'
    ?'Entrapment'
    :((aiIssue&&aiIssue!=='Other')?aiIssue:(local.issue||aiIssue||'Other'));

  const date=normalizeDate(pick(ai.date,local.date))||new Date().toISOString().slice(0,10);

  // Building must be location value for this project.
  const building=extractLocation(text)||pick(ai.building,local.building)||extractClient(text)||'Unknown Location';

  const reference=extractReference(text)||'N/A';
  const status=findOptionMatch(pick(ai.status,local.status),STATS)||local.status||'Open';

  const rawDesc=String(ai.description||'').trim();
  let description=rawDesc||local.description;
  if(rawDesc){
    if(elevator&&!new RegExp(`\\b${elevator.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}\\b`,'i').test(description)){
      description=`${elevator} incident. ${description}`.trim();
    }
    if(reference&&!new RegExp(reference.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&'),'i').test(description)){
      description=`${description} Reference: ${reference}.`.trim();
    }
  }

  const notes=String(ai.resolution_notes||'').trim()||local.notes||'No additional notes provided.';

  console.log(`[merge] cab=${cab} elevator=${elevator} building=${building} issue=${issue} status=${status} ref=${reference}`);

  return {date,building,location:building,elevator,issue,status,description,notes,reference};
}

// ── Route ─────────────────────────────────────────────────────────────────────

app.use(express.static(__dirname));

app.post('/api/pdf-import',upload.single('file'),async(req,res)=>{
  try{
    const file=req.file;
    if(!file)return res.status(400).json({error:'No PDF uploaded.'});
    if(file.mimetype!=='application/pdf'&&!/\.pdf$/i.test(file.originalname||''))
      return res.status(400).json({error:'Only PDF files are supported.'});

    const parsed=await pdfParse(file.buffer);
    const rawText=normText(parsed.text||'');
    if(!rawText)return res.status(422).json({error:'No text could be extracted from this PDF.'});

    console.log(`[pdf-import] extracted ${rawText.length} chars, type=${detectType(rawText)}`);

    let incident,warning='';
    try{
      const ai=await callOpenAI(rawText);
      console.log('[pdf-import] AI succeeded');
      incident=mergeWithLocal(ai,rawText);
    }catch(err){
      const msg=String(err.message||'');
      console.warn(`[pdf-import] AI failed (${msg}), using local fallback`);
      incident=parseLocal(rawText);
      warning=`AI unavailable (${msg}); used local fallback.`;
    }

    return res.json({incident,warning,rawText});
  }catch(err){
    console.error('[pdf-import] fatal',err.message);
    return res.status(500).json({error:'Failed to process PDF: '+err.message});
  }
});

const port=parseInt(process.env.PORT||'8080',10);

if(require.main===module){
  app.listen(port,()=>console.log(`LiftLog server running at http://localhost:${port}`));
}

module.exports={
  parseLocal,
  mergeWithLocal,
  detectType,
  extractCab,
  extractLocation,
  extractReference,
  getFirstDate,
  app
};