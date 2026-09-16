BEGIN;
DO $$
DECLARE extension_schema text;
BEGIN
  SELECT n.nspname INTO extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_jsonschema';
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION approval.valid_definition(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $body$
      SELECT %I.jsonb_matches_schema('__APPROVAL_DEFINITION_SCHEMA__'::json,value)
    $body$
  $fn$,extension_schema);
  EXECUTE format($fn$
    CREATE FUNCTION approval.valid_graph_facts(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $body$
      SELECT %I.jsonb_matches_schema('__APPROVAL_GRAPH_FACTS_SCHEMA__'::json,value)
    $body$
  $fn$,extension_schema);
END $$;
ALTER FUNCTION approval.valid_graph_facts(jsonb) OWNER TO supacloud_approval_owner;
SET LOCAL ROLE supacloud_approval_owner;
ALTER TABLE approval.runs DROP CONSTRAINT runs_execution_version_check;
ALTER TABLE approval.runs ADD CONSTRAINT runs_execution_version_check CHECK(execution_version IN(1,2,3));
ALTER TABLE approval.runs ADD COLUMN graph_parent_id uuid,ADD COLUMN graph_facts jsonb;
ALTER TABLE approval.runs ADD CONSTRAINT approval_graph_parent_fk FOREIGN KEY(tenant,graph_parent_id) REFERENCES approval.runs(tenant,id);
CREATE INDEX approval_graph_children ON approval.runs(tenant,graph_parent_id);
ALTER TABLE approval.wakeups ADD COLUMN graph_run_id uuid;
CREATE TABLE approval.graph_nodes(
  tenant text NOT NULL,run_id uuid NOT NULL,key text NOT NULL,position integer NOT NULL,node jsonb NOT NULL,
  selected boolean NOT NULL,status text NOT NULL CHECK(status IN('waiting','running','approved','rejected','returned','cancelled','timed_out','skipped')),
  child_run_id uuid UNIQUE,
  PRIMARY KEY(tenant,run_id,key),
  FOREIGN KEY(tenant,run_id) REFERENCES approval.runs(tenant,id),
  FOREIGN KEY(tenant,child_run_id) REFERENCES approval.runs(tenant,id)
);

CREATE FUNCTION approval.validate_graph(p_definition jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE node jsonb; other jsonb; visited text[]:=ARRAY[]::text[]; previous integer; group_key text; deps jsonb; count_default integer;
BEGIN
  IF p_definition->>'schemaVersion'<>'5' THEN RETURN; END IF;
  IF (SELECT count(*)<>count(DISTINCT n->>'key') FROM jsonb_array_elements(p_definition->'nodes') n) THEN
    RAISE EXCEPTION 'APPROVAL_DUPLICATE_NODE';
  END IF;
  FOR node IN SELECT * FROM jsonb_array_elements(p_definition->'nodes') LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(node->'after') dep WHERE dep=node->>'key'
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_definition->'nodes') n WHERE n->>'key'=dep)) THEN
      RAISE EXCEPTION 'APPROVAL_GRAPH_DEPENDENCY_INVALID';
    END IF;
    IF ((node ? 'quorum')::integer+(node ? 'quorumPercent')::integer)<>(CASE WHEN node->>'mode'='quorum' THEN 1 ELSE 0 END) THEN
      RAISE EXCEPTION 'APPROVAL_QUORUM_INVALID';
    END IF;
    IF ((node ? 'when')::integer+(node ? 'default')::integer)<>(CASE WHEN node ? 'choice' THEN 1 ELSE 0 END) THEN
      RAISE EXCEPTION 'APPROVAL_CHOICE_INVALID';
    END IF;
  END LOOP;
  FOR group_key IN SELECT DISTINCT n->>'choice' FROM jsonb_array_elements(p_definition->'nodes') n WHERE n ? 'choice' LOOP
    deps:=NULL;count_default:=0;previous:=0;
    FOR node IN SELECT * FROM jsonb_array_elements(p_definition->'nodes') n WHERE n->>'choice'=group_key LOOP
      SELECT coalesce(jsonb_agg(x ORDER BY x),'[]'::jsonb) INTO other FROM jsonb_array_elements_text(node->'after') x;
      IF deps IS NOT NULL AND deps<>other THEN RAISE EXCEPTION 'APPROVAL_CHOICE_INVALID'; END IF;
      deps:=other;previous:=previous+1;
      IF node ? 'default' THEN count_default:=count_default+1; END IF;
    END LOOP;
    IF count_default<>1 OR previous<2 THEN RAISE EXCEPTION 'APPROVAL_CHOICE_INVALID'; END IF;
  END LOOP;
  WHILE cardinality(visited)<jsonb_array_length(p_definition->'nodes') LOOP
    previous:=cardinality(visited);
    FOR node IN SELECT * FROM jsonb_array_elements(p_definition->'nodes') LOOP
      IF NOT(node->>'key'=ANY(visited)) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(node->'after') dep WHERE NOT(dep=ANY(visited))) THEN
        visited:=array_append(visited,node->>'key');
      END IF;
    END LOOP;
    IF previous=cardinality(visited) THEN RAISE EXCEPTION 'APPROVAL_GRAPH_CYCLE'; END IF;
  END LOOP;
END $$;
CREATE FUNCTION approval.graph_definition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN PERFORM approval.validate_graph(NEW.definition); RETURN NEW; END $$;
CREATE TRIGGER approval_graph_definition BEFORE INSERT ON approval.definitions
  FOR EACH ROW EXECUTE FUNCTION approval.graph_definition_guard();

CREATE FUNCTION approval.resolve_graph_facts(p_tenant text,p_entity text,p_resolver text) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'APPROVAL_GRAPH_FACTS_ADAPTER_REQUIRED'; END $$;

DO $$
DECLARE body text;
BEGIN
  body:=pg_get_functiondef('approval.protect_subject()'::regprocedure);
  body:=replace(body,'IN (''3'',''4'')','IN (''3'',''4'',''5'')');
  EXECUTE body;
END $$;
CREATE FUNCTION approval.graph_metadata_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF OLD.graph_facts IS DISTINCT FROM NEW.graph_facts OR
    (OLD.graph_parent_id IS NOT NULL AND OLD.graph_parent_id IS DISTINCT FROM NEW.graph_parent_id) THEN
    RAISE EXCEPTION 'APPROVAL_GRAPH_METADATA_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_graph_metadata BEFORE UPDATE ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.graph_metadata_guard();

CREATE FUNCTION approval.schedule_graph(p_tenant text,p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; token uuid:=gen_random_uuid();
BEGIN
  PERFORM approval.check_execution_version(3);
  SELECT * INTO STRICT r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF r.status<>'pending' THEN RETURN; END IF;
  UPDATE approval.runs SET wait_token=token,engine_id=df.start(
    df.seq(df.wait_for_signal('changed',greatest(1,ceil(extract(epoch FROM r.deadline-clock_timestamp()))::integer)),
      format('SELECT approval.graph_tick(%L,%L::uuid,%L::uuid)',p_tenant,p_run,token)),
    'approval-graph',transaction_mode=>'caller') WHERE id=p_run;
END $$;

CREATE FUNCTION approval.graph_progress(p_tenant text,p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; n approval.graph_nodes; made_progress boolean; child jsonb; step jsonb;
  child_definition jsonb; definition_key text; resolution jsonb; subject text; outcome text;
BEGIN
  PERFORM approval.check_execution_version(3);
  SELECT * INTO STRICT r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF r.status<>'pending' THEN RETURN; END IF;
  SELECT g.status INTO outcome FROM approval.graph_nodes g WHERE g.tenant=p_tenant AND g.run_id=p_run
    AND g.status IN('rejected','returned','cancelled','timed_out') ORDER BY g.position LIMIT 1;
  IF outcome IS NOT NULL THEN
    UPDATE approval.runs SET status=outcome,row_version=row_version+1,finished_at=clock_timestamp() WHERE id=p_run;
    INSERT INTO approval.events(tenant,run_id,kind,detail) VALUES(p_tenant,p_run,'graph_'||outcome,'{}');
    RETURN;
  END IF;
  SELECT definition->>'subjectResolver' INTO subject FROM approval.definitions
    WHERE tenant=p_tenant AND key=r.definition_key AND version=r.definition_version;
  LOOP
    made_progress:=false;
    FOR n IN SELECT g.* FROM approval.graph_nodes g WHERE g.tenant=p_tenant AND g.run_id=p_run AND g.status='waiting'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(g.node->'after') dep
        JOIN approval.graph_nodes d ON d.tenant=p_tenant AND d.run_id=p_run AND d.key=dep WHERE d.status NOT IN('approved','skipped'))
      ORDER BY g.position
    LOOP
      made_progress:=true;
      IF NOT n.selected OR (jsonb_array_length(n.node->'after')>0 AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements_text(n.node->'after') dep JOIN approval.graph_nodes d
          ON d.tenant=p_tenant AND d.run_id=p_run AND d.key=dep WHERE d.status='approved')) THEN
        UPDATE approval.graph_nodes SET status='skipped' WHERE tenant=p_tenant AND run_id=p_run AND key=n.key;
        CONTINUE;
      END IF;
      step:=n.node-ARRAY['after','choice','when','default','quorumPercent'];
      IF n.node ? 'quorumPercent' THEN
        resolution:=approval.assignment_resolution(p_tenant,r.entity_id,n.node->'assignment');
        step:=step||jsonb_build_object('quorum',ceil(jsonb_array_length(resolution->'actors')*(n.node->>'quorumPercent')::numeric/100)::integer);
      END IF;
      child_definition:=jsonb_build_object('schemaVersion',4,'subjectResolver',subject,'steps',jsonb_build_array(step));
      definition_key:='graph.'||replace(p_run::text,'-','')||'.'||n.position::text;
      INSERT INTO approval.definitions(tenant,key,version,definition) VALUES(p_tenant,definition_key,1,child_definition);
      child:=approval.start_v2(p_tenant,r.requester,gen_random_uuid(),definition_key,1,r.entity_id,r.business_snapshot);
      UPDATE approval.runs SET graph_parent_id=p_run WHERE id=(child->>'id')::uuid;
      UPDATE approval.graph_nodes SET status='running',child_run_id=(child->>'id')::uuid
        WHERE tenant=p_tenant AND run_id=p_run AND key=n.key;
      INSERT INTO approval.events(tenant,run_id,kind,detail) VALUES(p_tenant,p_run,'node_started',
        jsonb_build_object('node',n.key,'childRunId',child->>'id','quorum',step->'quorum'));
    END LOOP;
    EXIT WHEN NOT made_progress;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM approval.graph_nodes WHERE tenant=p_tenant AND run_id=p_run AND status IN('waiting','running')) THEN
    UPDATE approval.runs SET status='approved',row_version=row_version+1,finished_at=clock_timestamp() WHERE id=p_run;
    INSERT INTO approval.events(tenant,run_id,kind) VALUES(p_tenant,p_run,'graph_approved');
  END IF;
END $$;

CREATE FUNCTION approval.graph_child_outcome() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE request uuid:=gen_random_uuid(); parent_engine text;
BEGIN
  IF NEW.graph_parent_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'pending' THEN
    PERFORM approval.check_execution_version(3);
    SELECT engine_id INTO parent_engine FROM approval.runs WHERE tenant=NEW.tenant AND id=NEW.graph_parent_id;
    INSERT INTO approval.wakeups(tenant,request_id,run_id,target_engine_id,graph_run_id)
      VALUES(NEW.tenant,request,NEW.graph_parent_id,parent_engine,NEW.graph_parent_id);
    UPDATE approval.wakeups SET engine_id=df.start(
      format('SELECT approval.deliver_wakeup(%L,%L::uuid)',NEW.tenant,request),
      'approval-graph-progress',transaction_mode=>'caller') WHERE tenant=NEW.tenant AND request_id=request;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_graph_child_outcome AFTER UPDATE OF status ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.graph_child_outcome();

CREATE FUNCTION approval.graph_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE child approval.runs;
BEGIN
  IF NEW.execution_version=3 AND OLD.status='pending' AND NEW.status<>'pending' THEN
    PERFORM approval.check_execution_version(3);
    UPDATE approval.graph_nodes SET status='cancelled' WHERE tenant=NEW.tenant AND run_id=NEW.id AND status='waiting';
    FOR child IN SELECT * FROM approval.runs WHERE tenant=NEW.tenant AND graph_parent_id=NEW.id AND status='pending'
      ORDER BY id FOR UPDATE
    LOOP
      UPDATE approval.runs SET status='cancelled',row_version=row_version+1,finished_at=clock_timestamp() WHERE id=child.id;
      UPDATE approval.tasks SET status='cancelled' WHERE tenant=child.tenant AND run_id=child.id AND status='pending';
      INSERT INTO approval.events(tenant,run_id,kind,detail) VALUES(child.tenant,child.id,'graph_parent_ended',
        jsonb_build_object('parentRunId',NEW.id,'parentStatus',NEW.status));
      PERFORM approval.enqueue_wakeup(child.tenant,gen_random_uuid(),child.id,child.engine_id);
    END LOOP;
    PERFORM approval.enqueue_wakeup(NEW.tenant,gen_random_uuid(),NEW.id,NEW.engine_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_graph_terminal AFTER UPDATE OF status ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.graph_terminal();
DO $$
DECLARE body text;
BEGIN
  body:=pg_get_functiondef('approval.emit_outcome()'::regprocedure);
  body:=replace(body,'IF OLD.status IS DISTINCT FROM NEW.status','IF NEW.graph_parent_id IS NULL AND OLD.status IS DISTINCT FROM NEW.status');
  EXECUTE body;
END $$;

CREATE FUNCTION approval.reconcile_graph(p_tenant text,p_run uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; changed integer;
BEGIN
  PERFORM approval.check_execution_version(3);
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND OR r.status<>'pending' THEN RETURN false; END IF;
  UPDATE approval.graph_nodes g SET status=c.status FROM approval.runs c
    WHERE g.tenant=p_tenant AND g.run_id=p_run AND c.tenant=p_tenant AND c.id=g.child_run_id
      AND g.status='running' AND c.status<>'pending';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed>0 THEN UPDATE approval.runs SET row_version=row_version+1 WHERE tenant=p_tenant AND id=p_run; END IF;
  PERFORM approval.graph_progress(p_tenant,p_run);
  RETURN true;
END $$;
ALTER FUNCTION approval.deliver_wakeup(text,uuid) RENAME TO deliver_wakeup_without_graph;
CREATE FUNCTION approval.deliver_wakeup(p_tenant text,p_request uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE w approval.wakeups;
BEGIN
  SELECT * INTO w FROM approval.wakeups WHERE tenant=p_tenant AND request_id=p_request FOR UPDATE;
  IF NOT FOUND OR w.delivered_at IS NOT NULL THEN RETURN true; END IF;
  IF w.graph_run_id IS NOT NULL THEN
    PERFORM approval.reconcile_graph(p_tenant,w.graph_run_id);
    UPDATE approval.wakeups SET delivered_at=clock_timestamp() WHERE tenant=p_tenant AND request_id=p_request;
    RETURN true;
  END IF;
  RETURN approval.deliver_wakeup_without_graph(p_tenant,p_request);
END $$;

CREATE FUNCTION approval.graph_tick(p_tenant text,p_run uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs;
BEGIN
  PERFORM approval.check_execution_version(3);
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND OR r.status<>'pending' OR r.wait_token IS DISTINCT FROM p_token THEN RETURN false; END IF;
  IF r.deadline<=clock_timestamp() THEN
    UPDATE approval.runs SET status='timed_out',row_version=row_version+1,finished_at=clock_timestamp() WHERE id=p_run;
    INSERT INTO approval.events(tenant,run_id,kind) VALUES(p_tenant,p_run,'graph_timed_out');
  ELSE
    PERFORM approval.reconcile_graph(p_tenant,p_run);
    PERFORM approval.schedule_graph(p_tenant,p_run);
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION approval.start_graph(
  p_tenant text,p_actor text,p_request uuid,p_key text,p_version integer,p_entity text,p_snapshot jsonb,
  p_previous uuid DEFAULT NULL,p_expected bigint DEFAULT NULL,p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE d jsonb; facts jsonb; command jsonb; receipt jsonb; r uuid; node jsonb; group_key text;
  total_seconds integer; previous approval.runs; i integer:=0; matches integer;
BEGIN
  PERFORM approval.check_execution_version(3);
  command:=CASE WHEN p_previous IS NULL THEN jsonb_build_array('start',p_actor,p_key,p_version,p_entity,p_snapshot)
    ELSE jsonb_build_array('resubmit',p_actor,p_previous,p_expected,p_snapshot,p_reason) END;
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ACTOR'; END IF;
  SELECT definition INTO d FROM approval.definitions WHERE tenant=p_tenant AND key=p_key AND version=p_version;
  IF d IS NULL OR d->>'schemaVersion'<>'5' THEN RAISE EXCEPTION 'APPROVAL_GRAPH_INVALID'; END IF;
  IF p_previous IS NOT NULL THEN
    SELECT * INTO previous FROM approval.runs WHERE tenant=p_tenant AND id=p_previous FOR UPDATE;
    IF NOT FOUND OR previous.graph_parent_id IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
    IF previous.requester<>p_actor THEN RAISE EXCEPTION 'APPROVAL_NOT_REQUESTER'; END IF;
    IF previous.status<>'returned' THEN RAISE EXCEPTION 'APPROVAL_NOT_RETURNED'; END IF;
    IF p_expected IS NULL OR previous.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
    IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'APPROVAL_RETURN_REASON_REQUIRED'; END IF;
    IF previous.review_round>=1000 OR EXISTS(SELECT 1 FROM approval.runs WHERE tenant=p_tenant AND previous_run_id=p_previous) THEN
      RAISE EXCEPTION 'APPROVAL_RESUBMISSION_CONFLICT';
    END IF;
  END IF;
  PERFORM approval.verify_subject(p_tenant,p_entity,d->>'subjectResolver',p_snapshot);
  facts:=approval.resolve_graph_facts(p_tenant,p_entity,d->>'subjectResolver');
  IF facts IS NULL OR NOT approval.valid_graph_facts(facts) THEN RAISE EXCEPTION 'APPROVAL_GRAPH_FACTS_INVALID'; END IF;
  SELECT sum((n->>'timeoutSeconds')::integer) INTO total_seconds FROM jsonb_array_elements(d->'nodes') n;
  INSERT INTO approval.runs(tenant,definition_key,definition_version,entity_id,requester,deadline,business_snapshot,
    execution_version,graph_facts,root_run_id,previous_run_id,review_round)
    VALUES(p_tenant,p_key,p_version,p_entity,p_actor,clock_timestamp()+make_interval(secs=>total_seconds),p_snapshot,
      3,facts,previous.root_run_id,p_previous,coalesce(previous.review_round,0)+1) RETURNING id INTO r;
  FOR node IN SELECT * FROM jsonb_array_elements(d->'nodes') LOOP
    IF node ? 'when' AND NOT(facts ? (node->'when'->>'field')) THEN RAISE EXCEPTION 'APPROVAL_GRAPH_FACT_MISSING'; END IF;
    INSERT INTO approval.graph_nodes(tenant,run_id,key,position,node,selected,status)
      VALUES(p_tenant,r,node->>'key',i,node,NOT(node ? 'choice') OR
        coalesce(facts->(node->'when'->>'field')=node->'when'->'equals',false),'waiting');
    i:=i+1;
  END LOOP;
  FOR group_key IN SELECT DISTINCT g.node->>'choice' FROM approval.graph_nodes g WHERE g.run_id=r AND g.node ? 'choice' LOOP
    SELECT count(*) INTO matches FROM approval.graph_nodes g WHERE g.run_id=r AND g.node->>'choice'=group_key AND g.selected;
    IF matches>1 THEN RAISE EXCEPTION 'APPROVAL_AMBIGUOUS_ROUTE'; END IF;
    UPDATE approval.graph_nodes SET selected=(matches=0) WHERE run_id=r AND node->>'choice'=group_key AND node ? 'default';
  END LOOP;
  PERFORM approval.schedule_graph(p_tenant,r);
  PERFORM approval.graph_progress(p_tenant,r);
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,r,CASE WHEN p_previous IS NULL THEN 'started' ELSE 'resubmitted' END,p_actor,
      jsonb_build_object('businessSnapshot',p_snapshot,'facts',facts,'previousRunId',p_previous,'reason',p_reason));
  receipt:=approval.get_run(p_tenant,r);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

ALTER FUNCTION approval.get_run(text,uuid) RENAME TO get_run_without_graph;
CREATE FUNCTION approval.get_run(p_tenant text,p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt jsonb;
BEGIN
  receipt:=approval.get_run_without_graph(p_tenant,p_run);
  IF receipt->>'executionVersion'='3' THEN
    receipt:=receipt||jsonb_build_object('graphNodes',(SELECT jsonb_agg(jsonb_build_object(
      'key',key,'status',status,'childRunId',child_run_id) ORDER BY position) FROM approval.graph_nodes WHERE tenant=p_tenant AND run_id=p_run));
  END IF;
  RETURN receipt;
END $$;

-- Dispatchers are deliberately not the execution core; frozen functions remain unchanged.
DO $$
DECLARE body text;
BEGIN
  body:=pg_get_functiondef('approval.start(text,text,uuid,text,integer,text,jsonb)'::regprocedure);
  body:=replace(body,E'\nBEGIN\n',E'\nBEGIN\n  IF p_key LIKE ''graph.%'' THEN RAISE EXCEPTION ''APPROVAL_INTERNAL_DEFINITION''; END IF;\n');
  body:=replace(body,'IF schema_version=''4'' THEN',
    'IF schema_version=''5'' THEN RETURN approval.start_graph(p_tenant,p_actor,p_request,p_key,p_version,p_entity,p_snapshot); END IF;
     IF schema_version=''4'' THEN');
  EXECUTE body;
  body:=pg_get_functiondef('approval.schedule_wait(text,uuid)'::regprocedure);
  body:=replace(body,'IF version=2 THEN',
    'IF version=3 THEN PERFORM approval.schedule_graph(p_tenant,p_run); RETURN; END IF;
     IF version=2 THEN');
  EXECUTE body;
  body:=pg_get_functiondef('approval.resume_wait(text,uuid,uuid)'::regprocedure);
  body:=replace(body,'IF version=2 THEN',
    'IF version=3 THEN RETURN approval.graph_tick(p_tenant,p_run,p_token); END IF;
     IF version=2 THEN');
  EXECUTE body;
  body:=pg_get_functiondef('approval.advance(text,uuid)'::regprocedure);
  body:=replace(body,'IF version=2 THEN',
    'IF version=3 THEN RETURN approval.graph_tick(p_tenant,p_run,(SELECT wait_token FROM approval.runs WHERE tenant=p_tenant AND id=p_run)); END IF;
     IF version=2 THEN');
  EXECUTE body;
END $$;
ALTER FUNCTION approval.resubmit(text,text,uuid,uuid,bigint,jsonb,text) RENAME TO resubmit_without_graph;
CREATE FUNCTION approval.resubmit(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_snapshot jsonb,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs;
BEGIN
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF r.graph_parent_id IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_RESUBMIT_GRAPH_ROOT'; END IF;
  IF r.execution_version=3 THEN RETURN approval.start_graph(p_tenant,p_actor,p_request,r.definition_key,
    r.definition_version,r.entity_id,p_snapshot,p_run,p_expected,p_reason); END IF;
  RETURN approval.resubmit_without_graph(p_tenant,p_actor,p_request,p_run,p_expected,p_snapshot,p_reason);
END $$;
-- Cancellation has no graph-specific decision semantics; the terminal trigger cancels children.
INSERT INTO approval.execution_versions(version,functions)
  SELECT 3,jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='approval' AND p.proname IN(
      'start_graph','schedule_graph','graph_progress','graph_tick','graph_child_outcome','graph_terminal','reconcile_graph');
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA approval FROM PUBLIC;
REVOKE ALL ON FUNCTION approval.get_run_without_graph(text,uuid),approval.resubmit_without_graph(text,text,uuid,uuid,bigint,jsonb,text)
  FROM supacloud_approval_service;
REVOKE ALL ON TABLE approval.graph_nodes FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.get_run(text,uuid),approval.resubmit(text,text,uuid,uuid,bigint,jsonb,text) TO supacloud_approval_service;
COMMIT;
