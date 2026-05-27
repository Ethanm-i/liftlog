// Go back to line 552
// line 543

//
// Core lookup lists used throughout filters, forms, charts, and exports.
const ELEVATOR_LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ELEVATOR_NUMBERS=Array.from({length:26},(_,i)=>String(i+1));
const ELEVS=[...ELEVATOR_LETTERS,...ELEVATOR_NUMBERS];
const ISSUES=['Entrapment','Door Issue','Mechanical Failure','Power Outage','Inspection Issue','Noise/Vibration','Other'];
const STATS=['Open','In Progress','Resolved'];
const MOS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MOSL=['January','February','March','April','May','June','July','August','September','October','November','December'];
const ICOLS={'Entrapment':'#4b5563','Door Issue':'#6b7280','Mechanical Failure':'#374151','Power Outage':'#9ca3af','Inspection Issue':'#111827','Noise/Vibration':'#d1d5db','Other':'#6b7280'};

// LocalStorage keys and import requirements.
const STORAGE_KEY='liftlog2';
const STORAGE_RESET_KEY='liftlog_cleared_v1';
const ANTHROPIC_KEY_STORAGE='liftlog_anthropic_key';
const ANTHROPIC_MODEL='claude-sonnet-4-20250514';
const AI_SYSTEM_PROMPT="You are an assistant that extracts elevator incident data from security report PDFs. Return ONLY a valid JSON object with these exact keys — no markdown, no explanation: date (YYYY-MM-DD, use the FIRST date found in the document, no exceptions), building (use ONLY the location field value, prioritizing 'LOCATION OF THE PROBLEM:' then 'Location:'), elevator (format 'Elevator X' — CAB # is the source; if letter use directly, if number 1–26 map it: 1=A, 2=B ... 10=J ... 26=Z), issue_type (one of: Entrapment, Door Issue, Mechanical Failure, Power Outage, Inspection Issue, Noise/Vibration, Other — if document title is 'Incident Report' it is ALWAYS Entrapment; if 'Elevator Call Log' determine from description), status (Open if elevator still out of service or repair pending; Resolved if occupant released and elevator cleared same day, or if technician name and actual arrival time are both present), description (2–3 sentence plain-English summary with only incident-relevant facts; exclude form boilerplate/admin/contact text; MUST include the elevator identifier, any reference or service ticket number found, and what happened), resolution_notes (1–2 sentence summary of actions taken or technician findings, include technician name if present).";
const REQUIRED_IMPORT_FIELDS=['date','building','elevator','issue','status'];
const PDF_FIELD_LABELS={
  date:['date','incident date','report date','service date'],
  building:['building','location','site','property'],
  elevator:['elevator','lift','elevator id','lift id','unit'],
  issue:['issue type','incident type','issue','problem','event type'],
  status:['status','case status','incident status'],
  description:['description','incident description','summary','details','event summary'],
  notes:['resolution notes','notes','resolution','actions taken','corrective action','follow up']
};

const cssVar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// Small DOM/data helpers to keep render functions focused on intent.
const $=id=>document.getElementById(id);
const setText=(id,value)=>{$(id).textContent=value};
const setHtml=(id,value)=>{$(id).innerHTML=value};
const countWhere=(rows,predicate)=>rows.reduce((sum,row)=>sum+(predicate(row)?1:0),0);
const getIncidentsByYear=year=>load().filter(row=>row.date.startsWith(year));
const formatElevatorLabel=elevator=>`Elevator ${elevator}`;
const isValidElevator=elevator=>ELEVS.includes(String(elevator||'').trim().toUpperCase());

//  Storage helpers 
const load=()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch{return[]}};
const save=data=>localStorage.setItem(STORAGE_KEY,JSON.stringify(data));

if(window.pdfjsLib){
  window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

function escapeRx(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}

const PDF_ALL_LABELS=Object.values(PDF_FIELD_LABELS).flat().map(escapeRx).join('|');

function normalizePdfText(text){
  return text
    .replace(/\r/g,'')
    .split('\n')
    .map(line=>line.replace(/\s+/g,' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractPdfPageText(items){
  // PDF.js gives positioned tokens; we group by Y then sort by X so label:value lines survive extraction.
  const rows=[];
  items.forEach(item=>{
    const value=(item.str||'').trim();
    if(!value)return;
    const y=Math.round(item.transform?.[5]||0);
    const x=item.transform?.[4]||0;
    const row=rows.find(entry=>Math.abs(entry.y-y)<=2);
    if(row){
      row.parts.push({x,value});
      return;
    }
    rows.push({y,parts:[{x,value}]});
  });

  return rows
    .sort((a,b)=>b.y-a.y)
    .map(row=>row.parts.sort((a,b)=>a.x-b.x).map(part=>part.value).join(' '))
    .join('\n');
}

function findLabeledValue(text, labels){
  for(const label of labels){
    const rx=new RegExp(`(?:^|\\n)${escapeRx(label)}\\s*[:\\-]\\s*(.+?)(?=\\n(?:${PDF_ALL_LABELS})\\s*[:\\-]|$)`,'is');
    const match=text.match(rx);
    if(match&&match[1])return match[1].trim();
  }
  return '';
}

function stripLabeledLines(text){
  if(!text)return '';
  const labelRx=new RegExp(`^(?:${PDF_ALL_LABELS})\\s*[:\\-]\\s*`,'i');
  return text
    .split('\n')
    .map(line=>line.trim())
    .filter(line=>line&&!labelRx.test(line))
    .join('\n')
    .trim();
}

function normalizeDate(raw){
  if(!raw)return '';
  const cleaned=raw.replace(/\./g,'/').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(cleaned))return cleaned;
  const slash=cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if(slash){
    const month=slash[1].padStart(2,'0');
    const day=slash[2].padStart(2,'0');
    const year=slash[3].length===2?`20${slash[3]}`:slash[3];
    return `${year}-${month}-${day}`;
  }
  const parsed=new Date(cleaned);
  return Number.isNaN(parsed.getTime())?'':parsed.toISOString().slice(0,10);
}

function cabNumberToLetter(value){
  const num=parseInt(value,10);
  if(Number.isNaN(num)||num<1||num>26)return '';
  return ELEVATOR_LETTERS[num-1];
}

function normalizeElevator(raw, mode='mixed'){
  if(!raw)return '';
  const cleaned=String(raw).trim().toUpperCase();
  const letter=cleaned.match(/\b([A-Z])\b/);
  const number=cleaned.match(/\b(2[0-6]|1\d|[1-9])\b/);

  if(mode==='letter'){
    if(letter&&isValidElevator(letter[1]))return letter[1];
    return number?cabNumberToLetter(number[1]):'';
  }

  if(mode==='numeric'){
    if(number)return String(parseInt(number[1],10));
    return '';
  }

  if(letter&&isValidElevator(letter[1]))return letter[1];
  if(number&&isValidElevator(String(parseInt(number[1],10))))return String(parseInt(number[1],10));
  return '';
}

function findOptionMatch(raw, options){
  if(!raw)return '';
  const lowered=raw.toLowerCase();
  return options.find(option=>lowered.includes(option.toLowerCase()))||'';
}

function getFirstDate(text){
  const monthNames='jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const rx=new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b|\\b(?:${monthNames})\\s+\\d{1,2},?\\s+\\d{2,4}\\b`,'ig');
  const matches=[...text.matchAll(rx)];
  for(const match of matches){
    const normalized=normalizeDate(match[0]);
    if(normalized)return normalized;
  }
  return '';
}

function extractLocationValue(text){
  return findLabeledValue(text,['location of the problem','location'])||'';
}

function trimBoilerplate(text){
  if(!text)return '';
  const noisy=/^(incident report|elevator call log|marksman|page\s+\d+|date|time|client|location|cab\s*#|technician|signature|phone|email|address|site|property|status|issue type|description of incident|action\(s\) taken|actions taken|location of the problem|description of the problem)\b/i;
  return text
    .split('\n')
    .map(line=>line.replace(/\s+/g,' ').trim())
    .filter(line=>line&&line.length>8&&!noisy.test(line))
    .join(' ')
    .trim();
}

function pickRelevantSentences(text,maxSentences=2){
  const cleaned=trimBoilerplate(text);
  if(!cleaned)return '';
  const keys=/(elevator|lift|cab|stuck|trapped|entrap|door|fault|alarm|out of service|technician|rescue|release|repair|service|ticket|reference|returned to service)/i;
  const sentences=cleaned.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
  const relevant=sentences.filter(sentence=>keys.test(sentence));
  const chosen=(relevant.length?relevant:sentences).slice(0,maxSentences);
  return chosen.join(' ').replace(/\s+/g,' ').trim();
}

function summarizeDescription(text){
  // Keep description strictly as a short incident summary.
  return pickRelevantSentences(text,2);
}

function detectPdfType(text){
  if(/incident report/i.test(text))return 'incident_report';
  if(/elevator call log/i.test(text))return 'elevator_call_log';
  return 'generic';
}

function extractReferenceNumber(text){
  const patterns=[
    /(kone\s+service\s+ticket\s*#?\s*[a-z0-9-]+)/i,
    /(service\s+ticket\s*#?\s*[a-z0-9-]+)/i,
    /(reference\s*(?:number|no\.?|#)?\s*#?\s*[a-z0-9-]+)/i,
    /\b(?:ref(?:erence)?|ticket)\s*#\s*([a-z0-9-]{4,})\b/i,
    /#\s*([0-9]{6,})\b/
  ];
  for(const pattern of patterns){
    const match=text.match(pattern);
    if(match){
      const value=(match[1]||match[0]||'').replace(/\s+/g,' ').trim();
      if(value)return value;
    }
  }
  return '';
}

function getSection(text,startLabel,endLabels=[]){
  const source=`\n${text}`;
  const startRx=new RegExp(`\\n${escapeRx(startLabel)}\\s*:?\\s*`,'i');
  const startMatch=source.match(startRx);
  if(!startMatch)return '';
  const startIndex=(startMatch.index||0)+startMatch[0].length;
  const rest=source.slice(startIndex);
  let endIndex=rest.length;
  endLabels.forEach(label=>{
    const endRx=new RegExp(`\\n${escapeRx(label)}\\s*:?`,'i');
    const endMatch=rest.match(endRx);
    if(endMatch&&typeof endMatch.index==='number')endIndex=Math.min(endIndex,endMatch.index);
  });
  return rest.slice(0,endIndex).trim();
}

function summarizeLocal(text,maxSentences){
  const cleaned=text.replace(/\s+/g,' ').trim();
  if(!cleaned)return '';
  const sentences=cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  if(sentences.length<=maxSentences)return cleaned;
  return sentences.slice(0,maxSentences).join(' ');
}

function inferIssueFromDescription(text){
  const lowered=(text||'').toLowerCase();
  if(/door|closing|opening|sensor/.test(lowered))return 'Door Issue';
  if(/mechanical|motor|gear|brake|controller/.test(lowered))return 'Mechanical Failure';
  if(/power|outage|blackout|electric/.test(lowered))return 'Power Outage';
  if(/inspection|violation|code/.test(lowered))return 'Inspection Issue';
  if(/noise|vibration|rattle|shaking/.test(lowered))return 'Noise/Vibration';
  return 'Other';
}

function determineIncidentReportStatus(text){
  const lowered=text.toLowerCase();
  if(/out of service for the night|repair pending|pending repair|awaiting parts/.test(lowered))return 'Open';
  if(/occupant(?:s)? released|released safely|elevator cleared same day|returned to service/.test(lowered))return 'Resolved';
  return 'Open';
}

function determineCallLogStatus(text){
  const hasTechName=/technician\s*name\s*[:\-]\s*[^\n:]{2,}/i.test(text);
  const hasArrival=/actual\s+arrival\s+time\s*[:\-]\s*[^\n:]{2,}/i.test(text);
  return hasTechName&&hasArrival?'Resolved':'Open';
}

function ensureDescriptionHasRequirements(description,elevator,reference){
  let result=summarizeDescription(description);
  if(elevator&&!new RegExp(`\\b${escapeRx(formatElevatorLabel(elevator))}\\b`,'i').test(result)){
    result=`${formatElevatorLabel(elevator)} incident. ${result}`.trim();
  }
  if(reference&&!new RegExp(escapeRx(reference),'i').test(result)){
    result=`${result} Reference: ${reference}.`.trim();
  }
  return result.replace(/\s+/g,' ').trim();
}

function parseLocalByType(text){
  const normalized=normalizePdfText(text);
  const type=detectPdfType(normalized);
  const reference=extractReferenceNumber(normalized);
  const locationValue=extractLocationValue(normalized);

  if(type==='incident_report'){
    const location=locationValue;
    const cabMatch=location.match(/cab\s*#?\s*(2[0-6]|1\d|[1-9])/i);
    const elevator=cabMatch?cabNumberToLetter(cabMatch[1]):normalizeElevator(location,'letter');
    const descSection=getSection(normalized,'Description of Incident',['Action(s) Taken','Actions Taken','Technician','Resolution']);
    const notesSection=getSection(normalized,'Action(s) Taken',['Technician','Signature','Date']);
    return {
      type,
      date:getFirstDate(normalized),
      building:location,
      elevator,
      issue:'Entrapment',
      status:determineIncidentReportStatus(normalized),
      description:ensureDescriptionHasRequirements(descSection||stripLabeledLines(normalized),elevator,reference),
      notes:pickRelevantSentences(notesSection,2),
      reference
    };
  }

  if(type==='elevator_call_log'){
    const building=locationValue;
    const cab=findLabeledValue(normalized,['cab #','cab'])||normalized.match(/cab\s*#\s*[:\-]?\s*([a-z]|2[0-6]|1\d|[1-9])/i)?.[1]||'';
    const elevator=normalizeElevator(cab,'letter')||normalizeElevator(cab);
    const problem=getSection(normalized,'DESCRIPTION OF THE PROBLEM',['TECHNICIAN','ACTION','FINDINGS','COMMENTS']);
    const techNotes=getSection(normalized,'TECHNICIAN',['SIGNATURE','DATE'])||getSection(normalized,'FINDINGS',['SIGNATURE','DATE']);
    return {
      type,
      date:getFirstDate(normalized),
      building,
      elevator,
      issue:inferIssueFromDescription(problem),
      status:determineCallLogStatus(normalized),
      description:ensureDescriptionHasRequirements(problem||stripLabeledLines(normalized),elevator,reference),
      notes:pickRelevantSentences(techNotes,2),
      reference
    };
  }

  const date=findLabeledValue(normalized,PDF_FIELD_LABELS.date)||getFirstDate(normalized);
  const building=locationValue||findLabeledValue(normalized,PDF_FIELD_LABELS.building);
  const elevator=findLabeledValue(normalized,PDF_FIELD_LABELS.elevator)||normalized.match(/(?:elevator|lift)\s*([a-z]|2[0-6]|1\d|[1-9])\b/i)?.[1]||'';
  const issue=findLabeledValue(normalized,PDF_FIELD_LABELS.issue)||findOptionMatch(normalized,ISSUES);
  const status=findLabeledValue(normalized,PDF_FIELD_LABELS.status)||findOptionMatch(normalized,STATS);
  const description=findLabeledValue(normalized,PDF_FIELD_LABELS.description)||stripLabeledLines(normalized);
  const notes=findLabeledValue(normalized,PDF_FIELD_LABELS.notes);

  return {
    type,
    date:normalizeDate(date),
    building,
    elevator:normalizeElevator(elevator),
    issue:findOptionMatch(issue,ISSUES),
    status:findOptionMatch(status,STATS),
    description:ensureDescriptionHasRequirements(description,normalizeElevator(elevator),reference),
    notes:pickRelevantSentences(notes,2),
    reference
  };
}

async function summarizeWithAnthropic(text){
  const apiKey=(localStorage.getItem(ANTHROPIC_KEY_STORAGE)||'').trim();
  if(!apiKey)throw new Error('missing_api_key');
  const payload={
    model:ANTHROPIC_MODEL,
    max_tokens:700,
    system:AI_SYSTEM_PROMPT,
    messages:[{role:'user',content:[{type:'text',text}]}]
  };
  const response=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-api-key':apiKey,
      'anthropic-version':'2023-06-01'
    },
    body:JSON.stringify(payload)
  });
  if(!response.ok)throw new Error(`anthropic_${response.status}`);
  const data=await response.json();
  const raw=(data.content||[]).map(part=>part.text||'').join(' ').trim();
  if(!raw)throw new Error('anthropic_empty');
  const start=raw.indexOf('{');
  const end=raw.lastIndexOf('}');
  if(start<0||end<0||end<=start)throw new Error('anthropic_json_missing');
  return JSON.parse(raw.slice(start,end+1));
}

function mapAiResult(aiResult,rawText){
  const parsed=aiResult||{};
  const reference=extractReferenceNumber(rawText);
  const normalizedRaw=normalizePdfText(rawText);
  const issue=findOptionMatch(parsed.issue_type,ISSUES);
  const elevatorToken=normalizeElevator(String(parsed.elevator||'').replace(/elevator\s*/i,''),'letter')||normalizeElevator(parsed.elevator);
  const locationValue=extractLocationValue(normalizedRaw);
  return {
    date:normalizeDate(parsed.date||''),
    building:locationValue||(parsed.building||'').trim(),
    elevator:elevatorToken,
    issue:issue||'Other',
    status:findOptionMatch(parsed.status,STATS),
    description:ensureDescriptionHasRequirements((parsed.description||'').trim(),elevatorToken,reference),
    notes:pickRelevantSentences((parsed.resolution_notes||'').trim(),2),
    reference
  };
}

function showAddToast(kind,message){
  const toast=$('add-toast');
  toast.className=`toast ${kind} show`;
  toast.textContent=message;
  setTimeout(()=>toast.classList.remove('show'),4000);
}

function setImportStatus(kind,message){
  const status=$('pdf-status');
  status.className=`import-status ${kind}`;
  status.textContent=message;
}

function clearAutoFillHighlight(){
  document.querySelectorAll('.fgr').forEach(group=>group.classList.remove('auto-hit'));
}

function markAutoFillHighlight(record){
  const fieldToGroup={
    date:'f-date',
    building:'f-bld',
    elevator:'f-elev',
    issue:'f-issue',
    status:'f-stat',
    description:'f-desc',
    notes:'f-notes'
  };
  clearAutoFillHighlight();
  Object.entries(fieldToGroup).forEach(([key,id])=>{
    if(!record[key])return;
    const input=$(id);
    const group=input?.closest('.fgr');
    if(group)group.classList.add('auto-hit');
  });
}

function fillIncidentForm(record){
  if(record.date)$('f-date').value=record.date;
  if(record.building)$('f-bld').value=record.building;
  if(record.elevator)$('f-elev').value=formatElevatorLabel(record.elevator);
  if(record.issue)$('f-issue').value=record.issue;
  if(record.status)$('f-stat').value=record.status;
  if(record.description)$('f-desc').value=record.description;
  if(record.notes)$('f-notes').value=record.notes;
  markAutoFillHighlight(record);
}

function applyImportDefaults(incident){
  const today=new Date().toISOString().slice(0,10);
  return {
    ...incident,
    date:incident.date||today,
    building:incident.building||'',
    elevator:incident.elevator||'A',
    issue:incident.issue||'Other',
    status:incident.status||'Open',
    description:incident.description||'PDF report imported. Review details and save.'
  };
}

function clearIncidentForm(){
  $('f-date').value=new Date().toISOString().slice(0,10);
  $('f-bld').value='';
  $('f-elev').selectedIndex=0;
  $('f-issue').selectedIndex=0;
  $('f-stat').value='Open';
  $('f-desc').value='';
  $('f-notes').value='';
  clearAutoFillHighlight();
  setImportStatus('', 'Ready for a single incident report PDF.');
}

async function processPdfFile(file){
  if(!file)return;
  if(file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf')){
    setImportStatus('fail','Only .pdf files are supported.');
    showAddToast('err','Upload a PDF file only.');
    return;
  }
  if(!window.pdfjsLib){
    setImportStatus('fail','PDF parsing library is unavailable. Refresh and try again.');
    showAddToast('err','PDF import is unavailable right now.');
    return;
  }

  try{
    setImportStatus('loading','Reading PDF...');
    const bytes=new Uint8Array(await file.arrayBuffer());
    const pdf=await window.pdfjsLib.getDocument({data:bytes}).promise;
    const pages=[];
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
      const page=await pdf.getPage(pageNumber);
      const text=await page.getTextContent();
      pages.push(extractPdfPageText(text.items));
    }

    const rawText=pages.join('\n');
    let incident;
    try{
      setImportStatus('loading','Summarizing with AI...');
      const ai=await summarizeWithAnthropic(rawText);
      incident=mapAiResult(ai,rawText);
    }catch{
      incident=parseLocalByType(rawText);
    }

    incident=applyImportDefaults(incident);
    const matched=Object.entries(incident).filter(([,value])=>Boolean(value));
    if(!matched.length){
      setImportStatus('fail','No recognizable incident fields were found in that PDF.');
      showAddToast('err','PDF imported, but no form fields could be matched.');
      return;
    }

    fillIncidentForm(incident);
    setImportStatus('done',`${matched.length} fields auto-filled. Review and click Save.`);
    showAddToast('ok','PDF imported. Click Save Incident to add it to the Incident Log.');
  }catch(error){
    setImportStatus('fail','Could not read that PDF. Use a text-based PDF with labeled fields.');
    showAddToast('err',`PDF import failed: ${error.message}`);
  }
}



//  Year dropdown 
function buildYearList(){
  const thisYear=new Date().getFullYear();
  const dataYears=new Set(load().map(r=>r.date.slice(0,4)));
  const yrs=new Set();
  for(let y=2020;y<=2035;y++)yrs.add(String(y));
  dataYears.forEach(y=>yrs.add(y));
  return [...yrs].sort((a,b)=>b-a);
}

function initYrDrop(){
  const yrs=buildYearList();
  const sel=$('gyr');
  const cur=sel.value||String(new Date().getFullYear());
  sel.innerHTML=yrs.map(y=>`<option value="${y}">${y}</option>`).join('');
  sel.value=yrs.includes(cur)?cur:String(new Date().getFullYear());
}

const getYr=()=>$('gyr').value;

//  Page navigation 
function go(id){
  document.querySelectorAll('.pg').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.ni').forEach(b=>b.classList.remove('on'));
  $('pg-'+id).classList.add('on');
  document.querySelectorAll('.ni')[['dash','add','log','trap','dl'].indexOf(id)].classList.add('on');
  if(id==='dash')renderDash();
  if(id==='log')renderLog();
  if(id==='trap')renderTrap();
  if(id==='dl')renderDL();
}

function refresh(){renderDash();renderLog();renderTrap();renderDL()}

//  Dashboard 
function renderDash(){
  const yr=getYr();
  const data=getIncidentsByYear(yr);
  const trap=countWhere(data,row=>row.issue==='Entrapment');
  setText('dash-sub',`${data.length} incidents recorded in ${yr}`);
  setText('k-tot',data.length);
  setText('k-tr',trap);
  setText('k-ot',data.length-trap);
  setText('k-op',countWhere(data,row=>row.status==='Open'));
  setText('k-ip',countWhere(data,row=>row.status==='In Progress'));
  setText('k-re',countWhere(data,row=>row.status==='Resolved'));

  const ec={};ELEVS.forEach(l=>ec[l]=0);data.forEach(r=>ec[r.elevator]=(ec[r.elevator]||0)+1);
  const top=Object.entries(ec).sort((a,b)=>b[1]-a[1])[0];
  setText('top-elev',top&&top[1]>0?`${formatElevatorLabel(top[0])} - ${top[1]} incidents`:'No incidents yet');

  const maxE=Math.max(1,...Object.values(ec));
  setHtml('elev-bars',ELEVS.map(l=>`<div class="br"><div class="bl">${formatElevatorLabel(l)}</div><div class="bt"><div class="bf" style="width:${Math.round(ec[l]/maxE*100)}%"></div></div><div class="bc">${ec[l]}</div></div>`).join(''));

  const ic={};ISSUES.forEach(t=>ic[t]=0);data.forEach(r=>ic[r.issue]=(ic[r.issue]||0)+1);
  drawPie(ic,data.length);

  const mc={};for(let i=0;i<12;i++)mc[i]=0;data.forEach(r=>{const m=parseInt(r.date.slice(5,7))-1;mc[m]=(mc[m]||0)+1});
  const maxM=Math.max(1,...Object.values(mc));
  const trendOn=cssVar('--blue')||'#4b5563';
  const trendOff=cssVar('--bdr')||'#9ca3af';
  setHtml('trend',Object.values(mc).map(v=>`<div class="tc"><div class="tb" style="height:${Math.round(v/maxM*88)+2}px;background:${v?trendOn:trendOff}"></div></div>`).join(''));
  setHtml('trend-lbl',MOS.map(m=>`<div style="flex:1;text-align:center;font-size:9px;color:var(--tx3);font-family:var(--fh)">${m}</div>`).join(''));
}

function drawPie(ic,tot){
  const cv=$('pie-c'),ctx=cv.getContext('2d');
  const pieEmpty=cssVar('--bdr')||'#9ca3af';
  const pieCenter=cssVar('--surf')||'#f3f4f6';
  ctx.clearRect(0,0,160,160);
  const entries=Object.entries(ic).filter(([,v])=>v>0);
  if(!entries.length){ctx.fillStyle=pieEmpty;ctx.beginPath();ctx.arc(80,80,62,0,2*Math.PI);ctx.fill();}
  else{
    let s=-Math.PI/2;
    entries.forEach(([k,v])=>{const sl=(v/tot)*2*Math.PI;ctx.beginPath();ctx.moveTo(80,80);ctx.arc(80,80,62,s,s+sl);ctx.fillStyle=ICOLS[k]||'#5c637a';ctx.fill();s+=sl});
    ctx.beginPath();ctx.arc(80,80,34,0,2*Math.PI);ctx.fillStyle=pieCenter;ctx.fill();
  }
  setHtml('pie-leg',entries.map(([k,v])=>`
  <div class="pi"><div class="pd" style="background:${ICOLS[k]}"></div><div class="pn">${k}</div><div class="pv">${v} <span class="ppc">
  ${tot?Math.round(v/tot*100):0}%</span></div></div>`).join(''));
}

//  Badge helpers 
function bClass(i){const m={'Entrapment':'entr','Door Issue':'door','Mechanical Failure':'mech','Power Outage':'powr'};return'b-'+(m[i]||'othr')}
function sClass(s){return s==='Open'?'b-open':s==='In Progress'?'b-prog':'b-res'}

//  Incident Log 
function renderLog(){
  let data=load();
  const fy=$('lf-yr').value,fm=$('lf-mo').value,
        fe=$('lf-el').value,fi=$('lf-is').value,
        fs=$('lf-st').value,fq=($('lf-q').value||'').toLowerCase();
  if(fy)data=data.filter(r=>r.date.startsWith(fy));
  if(fm)data=data.filter(r=>parseInt(r.date.slice(5,7))===parseInt(fm));
  if(fe)data=data.filter(r=>r.elevator===fe);
  if(fi)data=data.filter(r=>r.issue===fi);
  if(fs)data=data.filter(r=>r.status===fs);
  if(fq)data=data.filter(r=>(r.building||'').toLowerCase().includes(fq)||(r.description||'').toLowerCase().includes(fq)||(r.notes||'').toLowerCase().includes(fq));
  data.sort((a,b)=>b.date.localeCompare(a.date));
  setText('log-cnt',data.length);
  setHtml('log-body',data.length
    ?data.map(r=>`<tr><td>${r.id}</td><td>${r.date}</td><td>${r.building||'-'}</td><td>${formatElevatorLabel(r.elevator)}</td><td><span class="badge ${bClass(r.issue)}">${r.issue}</span></td><td style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.description||'').replace(/"/g,'&quot;')}">${r.description||'-'}</td><td><span class="badge ${sClass(r.status)}">${r.status}</span></td></tr>`).join('')
    :`<tr><td colspan="7"><div class="nd"><i class="ti ti-mood-empty"></i>No incidents match your filters.</div></td></tr>`);
}

//  Entrapment Tracker 
function renderTrap(){
  const yr=getYr();
  const data=getIncidentsByYear(yr).filter(r=>r.issue==='Entrapment');
  setText('trap-sub',`Passenger entrapments for ${yr}`);
  setText('tr-tot',data.length);
  setText('tr-op',countWhere(data,row=>row.status==='Open'));
  setText('tr-re',countWhere(data,row=>row.status==='Resolved'));
  const ec={};ELEVS.forEach(l=>ec[l]=0);data.forEach(r=>ec[r.elevator]=(ec[r.elevator]||0)+1);
  const nz=Object.entries(ec).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const maxE=Math.max(1,...nz.map(([,v])=>v));
  setHtml('trap-bars',nz.length
    ?nz.map(([l,v])=>`<div class="br"><div class="bl">${formatElevatorLabel(l)}</div><div class="bt"><div class="bf re" style="width:${Math.round(v/maxE*100)}%"></div></div><div class="bc">${v}</div></div>`).join('')
    :'<div style="color:var(--tx3);font-size:13px;padding:6px">No entrapments recorded for this year.</div>');
  data.sort((a,b)=>b.date.localeCompare(a.date));
  setHtml('trap-body',data.length
    ?data.map(r=>`<tr><td>${r.id}</td><td>${r.date}</td><td>${r.building||'-'}</td><td>${formatElevatorLabel(r.elevator)}</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.description||'-'}</td><td><span class="badge ${sClass(r.status)}">${r.status}</span></td><td style="color:var(--tx3)">${r.notes||'-'}</td></tr>`).join('')
    :`<tr><td colspan="7"><div class="nd"><i class="ti ti-circle-check"></i>No entrapments this year.</div></td></tr>`);
}

//  Download page 
function renderDL(){
  const yr=getYr();
  const data=getIncidentsByYear(yr);
  setText('dl-tot',data.length);
  setText('dl-tr',countWhere(data,row=>row.issue==='Entrapment'));
  setText('dl-op',countWhere(data,row=>row.status==='Open'));
}

//  Excel Export with embedded charts 
function exportXLSX(){
  const yr=getYr();
  const data=getIncidentsByYear(yr);
  const btn=$('xl-btn');
  const status=$('xl-status');
  btn.disabled=true;
  status.className='xl-status loading';
  status.textContent='Building workbook with charts...';

  try{
    const WB=XLSX.utils.book_new();

    //  Sheet 1: Incident Log 
    const logRows=data.map(r=>({'ID':r.id,'Date':r.date,'Building':r.building||'','Elevator':formatElevatorLabel(r.elevator),'Issue Type':r.issue,'Description':r.description||'','Status':r.status,'Resolution Notes':r.notes||''}));
    const wsLog=XLSX.utils.json_to_sheet(logRows.length?logRows:[{'Note':'No incidents for '+yr}]);
    wsLog['!cols']=[{wch:6},{wch:12},{wch:20},{wch:13},{wch:20},{wch:42},{wch:14},{wch:30}];
    wsLog['!freeze']={xSplit:0,ySplit:1};
    XLSX.utils.book_append_sheet(WB,wsLog,'Incident_Log');

    //  Sheet 2: Entrapments 
    const trapRows=data.filter(r=>r.issue==='Entrapment').map(r=>({'ID':r.id,'Date':r.date,'Building':r.building||'','Elevator':formatElevatorLabel(r.elevator),'Description':r.description||'','Status':r.status,'Resolution Notes':r.notes||''}));
    const wsTrap=XLSX.utils.json_to_sheet(trapRows.length?trapRows:[{'Note':'No entrapments for '+yr}]);
    wsTrap['!cols']=[{wch:6},{wch:12},{wch:20},{wch:13},{wch:42},{wch:14},{wch:30}];
    XLSX.utils.book_append_sheet(WB,wsTrap,'Entrapments');

    //  Sheet 3: Monthly Summary 
    const mc={};for(let i=0;i<12;i++)mc[i]={Month:MOSL[i],'Total Incidents':0,'Entrapments':0,'Open':0,'In Progress':0,'Resolved':0};
    data.forEach(r=>{const m=parseInt(r.date.slice(5,7))-1;mc[m]['Total Incidents']++;if(r.issue==='Entrapment')mc[m]['Entrapments']++;mc[m][r.status]=(mc[m][r.status]||0)+1});
    const wsMo=XLSX.utils.json_to_sheet(Object.values(mc));
    wsMo['!cols']=[{wch:14},{wch:16},{wch:14},{wch:10},{wch:13},{wch:10}];
    XLSX.utils.book_append_sheet(WB,wsMo,'Monthly_Summary');

    //  Sheet 4: Chart_Data (hidden source data for charts) 
    const ec={};ELEVS.forEach(l=>ec[l]=0);data.forEach(r=>ec[r.elevator]=(ec[r.elevator]||0)+1);
    const ic={};ISSUES.forEach(t=>ic[t]=0);data.forEach(r=>ic[r.issue]=(ic[r.issue]||0)+1);
    const mCounts=Object.values(mc).map(r=>r['Total Incidents']);

    // Chart data sheet layout:
    // A1:B53  = Elevator data (label | count)
    // C1:D8   = Issue type data (label | count)
    // E1:F13  = Monthly trend data (label | count)
    const chartRows=Math.max(ELEVS.length,ISSUES.length,MOS.length);
    const chartDataAoA=[['Elevator','Incidents','Issue Type','Count','Month','Incidents']];
    for(let i=0;i<chartRows;i++){
      chartDataAoA.push([
        ELEVS[i]?formatElevatorLabel(ELEVS[i]):'',
        ELEVS[i]?ec[ELEVS[i]]:'',
        ISSUES[i]||'',
        ISSUES[i]?ic[ISSUES[i]]:'',
        MOS[i]||'',
        typeof mCounts[i]==='number'?mCounts[i]:''
      ]);
    }
    const wsCD=XLSX.utils.aoa_to_sheet(chartDataAoA);
    wsCD['!cols']=[{wch:14},{wch:10},{wch:2},{wch:20},{wch:10},{wch:2},{wch:10},{wch:10}];
    XLSX.utils.book_append_sheet(WB,wsCD,'Chart_Data');

    //  Sheet 5: Dashboard (KPIs + charts anchored here) 
    const trap=data.filter(r=>r.issue==='Entrapment').length;
    const topE=Object.entries(ec).sort((a,b)=>b[1]-a[1])[0];
    const dashAoA=[
      [`LiftLog Annual Report - ${yr}`,'','','','','','','','','','','','','','',''],
      [''],
      ['METRIC','VALUE'],
      ['Total Incidents',data.length],
      ['Entrapments',trap],
      ['Other Incidents',data.length-trap],
      ['Open Cases',data.filter(r=>r.status==='Open').length],
      ['In Progress',data.filter(r=>r.status==='In Progress').length],
      ['Resolved',data.filter(r=>r.status==='Resolved').length],
      ['Elevator With Most Incidents',topE&&topE[1]>0?`${formatElevatorLabel(topE[0])} (${topE[1]} incidents)`:'N/A'],
    ];
    const wsDash=XLSX.utils.aoa_to_sheet(dashAoA);
    wsDash['!cols']=[{wch:30},{wch:22},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2},{wch:2}];
    XLSX.utils.book_append_sheet(WB,wsDash,'Dashboard');

    // SheetJS can write sheets quickly, but embedded charts need manual OpenXML parts.
    // We patch the generated .xlsx zip with drawing/chart XML and relationships.

    const elevEndRow=ELEVS.length+1;
    // Bar chart: Incidents by Elevator (Chart_Data A2:B53)
    const barChartXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Incidents by Elevator</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Chart_Data!$B$1</c:f></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Chart_Data!$A$2:$A$${elevEndRow}</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Chart_Data!$B$2:$B$${elevEndRow}</c:f></c:numRef></c:val>
        </c:ser>
        <c:axId val="1"/><c:axId val="2"/>
      </c:barChart>
      <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>
      <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/></c:legend>
  </c:chart>
</c:chartSpace>`;

    // Pie chart: Issue Type Breakdown (Chart_Data C2:D8)
    const pieChartXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Incidents by Issue Type</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:pieChart>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Chart_Data!$D$1</c:f></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Chart_Data!$C$2:$C$8</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Chart_Data!$D$2:$D$8</c:f></c:numRef></c:val>
        </c:ser>
        <c:firstSliceAng val="0"/>
      </c:pieChart>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/></c:legend>
  </c:chart>
</c:chartSpace>`;

    // Line chart: Monthly Trend (Chart_Data E2:F13)
    const lineChartXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Monthly Incident Trend</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:lineChart>
        <c:grouping val="standard"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Chart_Data!$F$1</c:f></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Chart_Data!$E$2:$E$13</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Chart_Data!$F$2:$F$13</c:f></c:numRef></c:val>
          <c:marker><c:symbol val="circle"/></c:marker>
          <c:smooth val="0"/>
        </c:ser>
        <c:axId val="1"/><c:axId val="2"/>
      </c:lineChart>
      <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>
      <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/></c:legend>
  </c:chart>
</c:chartSpace>`;

    // Drawing XML: anchors 3 charts onto the Dashboard sheet
    const drawingXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>27</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>
      <xdr:cNvPr id="2" name="Bar Chart"/><xdr:cNvGraphicFramePr/>
    </xdr:nvGraphicFramePr>
    <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
      <c:chart r:id="rId1"/>
    </a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>
  </xdr:twoCellAnchor>
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>11</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>18</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>27</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>
      <xdr:cNvPr id="3" name="Pie Chart"/><xdr:cNvGraphicFramePr/>
    </xdr:nvGraphicFramePr>
    <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
      <c:chart r:id="rId2"/>
    </a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>
  </xdr:twoCellAnchor>
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>28</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>18</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>43</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>
      <xdr:cNvPr id="4" name="Line Chart"/><xdr:cNvGraphicFramePr/>
    </xdr:nvGraphicFramePr>
    <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
      <c:chart r:id="rId3"/>
    </a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;

    // Relationships for the drawing (links drawing  chart files)
    const drawingRelsXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart3.xml"/>
</Relationships>`;

    // Write base workbook, then reopen as zip for chart/drawing injection.
    const wbOut=XLSX.write(WB,{type:'binary',bookType:'xlsx'});

      // Convert binary string  Uint8Array for JSZip
      // I need to come back to this 
    const s2ab=s=>{const b=new ArrayBuffer(s.length);const v=new Uint8Array(b);for(let i=0;i<s.length;i++)v[i]=s.charCodeAt(i)&0xFF;return b};

    // Lazy-load JSZip only when exporting to keep initial app load light.
    const script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    script.onload=async()=>{
      const zip=await JSZip.loadAsync(s2ab(wbOut));

      // Dashboard is the 5th appended sheet, so it maps to xl/worksheets/sheet5.xml.
      const dashSheetFile='xl/worksheets/sheet5.xml';
      const dashRelsDir='xl/worksheets/_rels/sheet5.xml.rels';

      // Patch the Dashboard sheet XML to reference the drawing
      let dashXml=await zip.file(dashSheetFile).async('string');
      if(!dashXml.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')){
        dashXml=dashXml.replace('<worksheet ','<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
      }
      if(!dashXml.includes('<drawing')){
        dashXml=dashXml.replace('</worksheet>','<drawing r:id="rId100"/></worksheet>');
        zip.file(dashSheetFile,dashXml);
      }

      // Add/update the Dashboard sheet's .rels to include the drawing relationship
      let dashRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
      zip.file(dashRelsDir,dashRels);

      // Add chart files
      zip.file('xl/charts/chart1.xml',barChartXml);
      zip.file('xl/charts/chart2.xml',pieChartXml);
      zip.file('xl/charts/chart3.xml',lineChartXml);

      // Add drawing file and its rels
      zip.file('xl/drawings/drawing1.xml',drawingXml);
      zip.file('xl/drawings/_rels/drawing1.xml.rels',drawingRelsXml);

      // Patch [Content_Types].xml to register new parts
      let ct=await zip.file('[Content_Types].xml').async('string');
      const ctPatches=[
        ['xl/charts/chart1.xml','application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],
        ['xl/charts/chart2.xml','application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],
        ['xl/charts/chart3.xml','application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],
        ['xl/drawings/drawing1.xml','application/vnd.openxmlformats-officedocument.drawing+xml'],
      ];
      ctPatches.forEach(([pn,ct_])=>{
        if(!ct.includes(pn)){
          ct=ct.replace('</Types>',`<Override PartName="/${pn}" ContentType="${ct_}"/></Types>`);
        }
      });
      zip.file('[Content_Types].xml',ct);

      // Generate final blob and trigger download
      const blob=await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=`LiftLog_${yr}_Report.xlsx`;
      a.click();

      status.className='xl-status done';
      status.textContent=`LiftLog_${yr}_Report.xlsx downloaded - open in Excel to see charts.`;
      btn.disabled=false;
    };
    script.onerror=()=>{
      status.className='xl-status fail';
      status.textContent='Could not load JSZip. Check your internet connection.';
      btn.disabled=false;
    };
    document.head.appendChild(script);
    return; // async path handles btn.disabled
  }catch(e){
    status.className='xl-status fail';
    status.textContent='Export failed: '+e.message;
    btn.disabled=false;
  }
}

//  CSV fallback 
function exportCSV(){
  const yr=getYr();
  const data=getIncidentsByYear(yr);
  const hdr=['ID','Date','Building','Elevator','Issue Type','Description','Status','Resolution Notes'];
  const esc=v=>typeof v==='string'&&(v.includes(',')||v.includes('"'))?`"${v.replace(/"/g,'""')}"`:(v||'');
  const rows=data.map(r=>[r.id,r.date,esc(r.building||''),formatElevatorLabel(r.elevator),r.issue,esc(r.description||''),r.status,esc(r.notes||'')]);
  const csv=[hdr.join(','),...rows.map(r=>r.join(','))].join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`LiftLog_${yr}.csv`;a.click();
}

//  Save Incident 
function saveInc(){
  const date=$('f-date').value;
  const bld=$('f-bld').value.trim();
  const elev=String($('f-elev').value).replace('Elevator ','').trim();
  const issue=$('f-issue').value;
  const stat=$('f-stat').value;
  const desc=$('f-desc').value.trim();
  const notes=$('f-notes').value.trim();
  if(!date||!bld){
    showAddToast('err','Please fill in Date and Building.');
    return;
  }
  const data=load();
  const id=data.length?Math.max(...data.map(r=>r.id))+1:1;
  data.push({id,date,building:bld,elevator:elev,issue,description:desc,status:stat,notes,created:new Date().toISOString()});
  save(data);
  showAddToast('ok',`Saved: ${formatElevatorLabel(elev)} - ${issue} on ${date}`);
  clearIncidentForm();
  initYrDrop();refresh();
}

//  Init filters 
function initFilters(){
  setHtml('f-elev',ELEVS.map(l=>`<option>${formatElevatorLabel(l)}</option>`).join(''));
  setHtml('f-issue',ISSUES.map(t=>`<option>${t}</option>`).join(''));
  const yrs=buildYearList();
  setHtml('lf-yr','<option value="">All Years</option>'+yrs.map(y=>`<option value="${y}">${y}</option>`).join(''));
  setHtml('lf-mo','<option value="">All Months</option>'+MOSL.map((m,i)=>`<option value="${i+1}">${m}</option>`).join(''));
  setHtml('lf-el','<option value="">All Elevators</option>'+ELEVS.map(l=>`<option value="${l}">${formatElevatorLabel(l)}</option>`).join(''));
  setHtml('lf-is','<option value="">All Issue Types</option>'+ISSUES.map(t=>`<option>${t}</option>`).join(''));
  setHtml('lf-st','<option value="">All Statuses</option>'+STATS.map(s=>`<option>${s}</option>`).join(''));
  $('f-date').value=new Date().toISOString().slice(0,10);
}

function initPdfImport(){
  const input=$('pdf-upload');
  const dropZone=$('pdf-drop-zone');
  const clearBtn=$('clear-btn');
  const keyInput=$('anthropic-key');
  if(input){
    input.addEventListener('change',async event=>{
      const file=event.target.files?.[0];
      await processPdfFile(file);
      event.target.value='';
    });
  }
  if(dropZone){
    ['dragenter','dragover'].forEach(evt=>dropZone.addEventListener(evt,e=>{
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-on');
    }));
    ['dragleave','drop'].forEach(evt=>dropZone.addEventListener(evt,e=>{
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-on');
    }));
    dropZone.addEventListener('drop',async event=>{
      const file=event.dataTransfer?.files?.[0];
      await processPdfFile(file);
    });
  }
  if(clearBtn)clearBtn.addEventListener('click',clearIncidentForm);
  if(keyInput){
    keyInput.value=localStorage.getItem(ANTHROPIC_KEY_STORAGE)||'';
    keyInput.addEventListener('change',()=>localStorage.setItem(ANTHROPIC_KEY_STORAGE,keyInput.value.trim()));
  }
}

//  Boot 
if(!localStorage.getItem(STORAGE_RESET_KEY)){
  localStorage.removeItem(STORAGE_KEY);
  localStorage.setItem(STORAGE_RESET_KEY,'1');
}
initYrDrop();
initFilters();
initPdfImport();
renderDash();
renderLog();
renderTrap();
renderDL();