import test from 'node:test';
import assert from 'node:assert/strict';
import {socialReaderPoolConfig} from '../src/server/social/reader.ts';
const uri='postgresql://nb_social_reader.exampleproject:fictional%21pass@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';
test('transaction pool changes only the reviewed shared-pooler port, keeps TLS/identity, bounds each instance and is explicitly reversible',()=>{
 const before=socialReaderPoolConfig({SOCIAL_READER_DATABASE_URL:uri});
 const after=socialReaderPoolConfig({SOCIAL_READER_DATABASE_URL:uri,SOCIAL_READER_CONNECTION_MODE:'transaction'});
 const original=new URL(before.connectionString!),candidate=new URL(after.connectionString!);
 assert.equal(original.port,'5432');assert.equal(candidate.port,'6543');candidate.port='5432';assert.equal(candidate.href,original.href);
 assert.deepEqual(after.ssl,{rejectUnauthorized:true});assert.equal(after.max,1);assert.equal(before.max,2);
 for(const key of ['idleTimeoutMillis','connectionTimeoutMillis','statement_timeout','query_timeout','application_name'] as const)assert.deepEqual(after[key],before[key]);
 assert.deepEqual(socialReaderPoolConfig({SOCIAL_READER_DATABASE_URL:uri,SOCIAL_READER_CONNECTION_MODE:'configured'}),before);
 assert.equal(new URL(socialReaderPoolConfig({SOCIAL_READER_DATABASE_URL:uri.replace(':5432/',':6543/'),SOCIAL_READER_CONNECTION_MODE:'transaction'}).connectionString!).port,'6543');
});
test('transaction mode rejects guessed hosts/ports, alternate identities, unsafe TLS and URI parameters before connecting',()=>{
 for(const url of [uri.replace('pooler.supabase.com','pooler.supabase.com.example.invalid'),uri.replace('aws-0-ap-southeast-1.pooler.supabase.com','db.exampleproject.supabase.co'),uri.replace(':5432/',':1234/'),uri.replace('nb_social_reader.exampleproject','postgres.exampleproject'),uri.replace('nb_social_reader.exampleproject','nb_social_reader'),uri+'?sslmode=disable',uri+'#wrong'])
  assert.throws(()=>socialReaderPoolConfig({SOCIAL_READER_DATABASE_URL:url,SOCIAL_READER_CONNECTION_MODE:'transaction'}),{code:'MISCONFIGURED'});
 assert.throws(()=>socialReaderPoolConfig({SOCIAL_READER_DATABASE_URL:uri,SOCIAL_READER_CONNECTION_MODE:'typo'}),{code:'MISCONFIGURED'});
 assert.throws(()=>socialReaderPoolConfig({SOCIAL_READER_DATABASE_URL:uri,SOCIAL_READER_CONNECTION_MODE:'transaction',SOCIAL_READER_DATABASE_TLS:'disable'}),{code:'MISCONFIGURED'});
});
