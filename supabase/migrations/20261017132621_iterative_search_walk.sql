-- Explicit stack traversal removes per-block SQL calls; text/reference order stays unchanged.
BEGIN;
INSERT INTO nb_read.migrations VALUES(3,NULL);
CREATE OR REPLACE FUNCTION nb_read.search_parts(p_blocks jsonb,p_depth integer DEFAULT 0) RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE stack jsonb[]:=ARRAY[jsonb_build_array(0,p_depth,NULL,p_blocks)]; top integer:=1;
  frame jsonb; value jsonb; b jsonb; child jsonb; row_value jsonb; run jsonb; media text; depth integer; kind integer; i integer; j integer;
BEGIN
  WHILE top>0 LOOP
    frame:=stack[top]; stack[top]:=NULL; top:=top-1;
    kind:=(frame->>0)::integer; depth:=(frame->>1)::integer; media:=frame->>2; value:=frame->3;
    IF value IS NULL OR value='null'::jsonb THEN CONTINUE; END IF;
    IF kind=0 THEN
      IF depth>32 OR jsonb_typeof(value)<>'array' OR jsonb_array_length(value)>20000 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
      FOR i IN REVERSE jsonb_array_length(value)-1..0 LOOP
        top:=top+1; stack[top]:=jsonb_build_array(1,depth,NULL,value->i);
      END LOOP;
    ELSIF kind=2 THEN
      FOR i IN 0..jsonb_array_length(value)-1 LOOP
        run:=value->i;
        IF run->'link'->>'kind'='unavailable' THEN CONTINUE; END IF;
        IF media IS NULL AND run->'link'->>'kind' IS DISTINCT FROM 'internal' THEN RETURN NEXT run->'text';
        ELSE RETURN NEXT jsonb_build_array(run->'text',CASE WHEN run->'link'->>'kind'='internal' THEN run->'link'->'href' ELSE NULL END,media); END IF;
      END LOOP;
    ELSIF kind=3 THEN RETURN NEXT value;
    ELSE
      b:=value;
      IF b->>'type'='image' THEN
        top:=top+1; stack[top]:=jsonb_build_array(2,depth,CASE WHEN b->'image'->>'src' LIKE '/media/%' THEN b->'image'->>'id' ELSE NULL END,b->'caption');
        CONTINUE;
      END IF;
      -- LIFO tasks are pushed in reverse documentPlainText order.
      IF b?'caption' THEN top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,b->'caption'); END IF;
      CASE b->>'type'
        WHEN 'code' THEN top:=top+1; stack[top]:=jsonb_build_array(3,depth,NULL,b->'code');
        WHEN 'equation' THEN top:=top+1; stack[top]:=jsonb_build_array(3,depth,NULL,b->'expression');
        WHEN 'toggle' THEN
          top:=top+1; stack[top]:=jsonb_build_array(0,depth+1,NULL,b->'children');
          top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,b->'title');
        WHEN 'callout' THEN top:=top+1; stack[top]:=jsonb_build_array(0,depth+1,NULL,b->'children');
        WHEN 'list' THEN FOR i IN REVERSE jsonb_array_length(b->'items')-1..0 LOOP
          child:=b->'items'->i;
          top:=top+1; stack[top]:=jsonb_build_array(0,depth+1,NULL,child->'children');
          top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,child->'text');
        END LOOP;
        WHEN 'columns' THEN FOR i IN REVERSE jsonb_array_length(b->'columns')-1..0 LOOP
          top:=top+1; stack[top]:=jsonb_build_array(0,depth+1,NULL,b->'columns'->i->'blocks');
        END LOOP;
        WHEN 'table' THEN FOR i IN REVERSE jsonb_array_length(b->'rows')-1..0 LOOP
          row_value:=b->'rows'->i;
          FOR j IN REVERSE jsonb_array_length(row_value)-1..0 LOOP
            top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,row_value->j);
          END LOOP;
        END LOOP;
        WHEN 'bookmark' THEN
          top:=top+1; stack[top]:=jsonb_build_array(3,depth,NULL,COALESCE(b->>'description',''));
          top:=top+1; stack[top]:=jsonb_build_array(3,depth,NULL,b->'title');
        ELSE NULL;
      END CASE;
      IF b?'text' THEN top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,b->'text'); END IF;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION nb_read_api.check_search_walk(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT FROM nb_read.migrations WHERE version=3 AND digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$')
$$;
REVOKE EXECUTE ON FUNCTION nb_read_api.check_search_walk(text) FROM PUBLIC,nb_writer;
GRANT EXECUTE ON FUNCTION nb_read_api.check_search_walk(text) TO nb_reader;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_read_api.check_search_walk(text) FROM %I',role_name);
  END LOOP;
END $$;
-- Register the reviewed third migration SHA in version=3 before enabling this reader.
COMMIT;
