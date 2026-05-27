const assert=require('assert');
const {parseLocal,mergeWithLocal}=require('../server');

function assertNoEmpty(incident,label){
  const keys=['date','building','location','elevator','issue','status','description','notes','reference'];
  keys.forEach(key=>{
    assert.ok(String(incident[key]||'').trim(),`${label}: expected non-empty ${key}`);
  });
}

function testIncidentReport(){
  const text=`
Incident Report
Date: 03/23/2026
Client: One Buckhead Plaza
LOCATION OF THE PROBLEM: 3060 Peachtree RD NW / 19th Floor
Service Elevator Cab #10 was stuck near the 19th floor with Eric Benitez inside.
KONE service ticket #17542681 was created. Occupant was released safely.
Action(s) Taken: Security assisted and elevator was placed out of service.
`;

  const incident=parseLocal(text);
  assert.strictEqual(incident.date,'2026-03-23');
  assert.strictEqual(incident.building,'3060 Peachtree RD NW / 19th Floor');
  assert.strictEqual(incident.elevator,'Elevator 10');
  assert.strictEqual(incident.issue,'Entrapment');
  assert.ok(incident.description.includes('#17542681'));
  assertNoEmpty(incident,'incident_report');
}

function testCallLog(){
  const text=`
ELEVATOR CALL LOG
DATE: 05/14/2026
LOCATION OF THE PROBLEM: 3060 Peachtree RD NW / 16th Floor
CAB #: G
DESCRIPTION OF THE PROBLEM:
On May 14, 2026, Elevator G was out of service on the 16th floor. No entrapment occurred.
KONE was contacted and service ticket reference #17466105 was created.
FULL NAME OF THE ELEVATOR TECHNICIAN: John Smith
ACTUAL TIME OF ARRIVAL: 13:24
Technician notes: Had to adjust the brake switch for elevator G.
`;

  const incident=parseLocal(text);
  assert.strictEqual(incident.date,'2026-05-14');
  assert.strictEqual(incident.building,'3060 Peachtree RD NW / 16th Floor');
  assert.strictEqual(incident.elevator,'Elevator G');
  assert.strictEqual(incident.issue,'Mechanical Failure');
  assert.strictEqual(incident.status,'Resolved');
  assert.ok(incident.description.includes('#17466105'));
  assertNoEmpty(incident,'call_log');
}

function testAiMergeRules(){
  const text=`
ELEVATOR CALL LOG
DATE: 05/14/2026
LOCATION OF THE PROBLEM: 3060 Peachtree RD NW / 16th Floor
CAB #: G
DESCRIPTION OF THE PROBLEM: Elevator was out of service. service ticket #17466105.
`;
  const ai={
    date:'2026-05-14',
    building:'wrong value',
    elevator:'Elevator Q',
    issue_type:'Other',
    status:'Open',
    description:'AI summary sample.',
    resolution_notes:'AI notes.'
  };

  const merged=mergeWithLocal(ai,text);
  assert.strictEqual(merged.building,'3060 Peachtree RD NW / 16th Floor');
  assert.strictEqual(merged.elevator,'Elevator G');
  assert.ok(merged.description.includes('AI summary sample.'));
  assertNoEmpty(merged,'ai_merge');
}

function run(){
  testIncidentReport();
  testCallLog();
  testAiMergeRules();
  console.log('All import pipeline tests passed.');
}

run();
