/** Fixed reader calls only. Both reads retain current eligibility and share a run/revision. */
function studyRead(note: boolean, documents = false): string {
  return `/* ${documents ? "study-note-detail" : note ? "study-note-eligibility" : "study-directory"} */
    WITH course AS MATERIALIZED (
      SELECT nb_v2_api.read_content('course',$1,NULL,'{}'::jsonb,0,1,NULL,NULL,false) AS value
    )
    SELECT jsonb_build_object('course',course.value,'notes',
      CASE WHEN jsonb_array_length(course.value->'records')=1 THEN
        nb_v2_api.read_content('study-note',${note ? "$2" : "NULL"},
          course.value#>>'{records,0,item,id}','{}'::jsonb,0,${note ? 1 : 5000},
          (course.value->>'runId')::uuid,(course.value->>'revision')::bigint,${documents ? "true" : "false"})
      ELSE NULL END) AS result FROM course`;
}

export const STUDY_NOTE_ELIGIBILITY_SQL = studyRead(true);
export const STUDY_DIRECTORY_SQL = studyRead(false);
export const STUDY_NOTE_DETAIL_SQL = studyRead(true,true);
