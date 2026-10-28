"""Isolated state/CLI checks; no real source scripts, credentials or sockets."""
from pathlib import Path
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CODE = ROOT / 'scripts/self-hosted-delivery'
sys.path.insert(0, str(CODE))
import completion as c
spec = importlib.util.spec_from_file_location('entry', CODE / 'sync-entry.py')
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='completion-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.run = str(uuid.uuid4())
        self.config = {'enabled': True, 'scheduled': False, 'stateRoot': str(self.root / 'state'),
                       'queueRoot': str(self.root / 'queue'), 'maintenanceState': str(self.root / 'maintenance.json'),
                       'adoptionRoot': str(self.root / 'adoption'), 'latestDeliveredFile': str(self.root / 'latest.json'),
                       'sharedLocks': [str(self.root / n) for n in ['maintenance.lock', 'manual-run.lock', 'writer-session.lock', 'worker.lock']],
                       'adoptionExpected': {'revision': '9', 'epoch': '6', 'schemaDigest': 'fictional-schema', 'configDigest': 'fictional-config'}}
        self.fixture(self.run)
        self.adopt(self.run)

    def fixture(self, run):
        base = Path(self.config['stateRoot']) / 'website-v2' / run
        c.save(base / 'receipt-private.json', {'runId': run, 'published': True, 'readerVerified': True, 'finishedAt': '2026-10-28T00:00:00Z'})
        c.save(base / 'collection-private/index-private.json', {'runId': run, 'collectionComplete': True})
        c.save(self.config['maintenanceState'], {'attempts': 60, 'runId': run, 'status': 'PUBLISHED_POST_INCOMPLETE'})

    def adopt(self, run, status='ADOPTED_VERIFIED'):
        root = Path(self.config['adoptionRoot'])
        path = root / 'runs' / str(uuid.uuid4()) / 'result.json'
        result = {'status': status, 'targetRun': run, 'exitCode': 0, 'locksReleased': True,
                  'owner': {'runId': run, 'committed': status == 'ADOPTED_VERIFIED',
                            'reusedExisting': status == 'ALREADY_ADOPTED_VERIFIED', **self.config['adoptionExpected']},
                  'reader': {'runId': run, 'revision': '9', 'schemaDigest': 'fictional-schema'}}
        c.save(path, result)
        c.save(root / 'latest.json', {'runId': run, 'receipt': str(path), 'status': status, 'exitCode': 0})
        return path

    def complete(self, _config, path):
        self.assertTrue(all(Path(p).exists() for p in self.config['sharedLocks']))
        v = c.read(path)
        v.update(status='COMPLETE', published=True, readerVerified=True)
        c.save(path, v)
        return 0

    def test_post_incomplete_published_source_delivers(self):
        self.assertEqual(c.on_success(self.config, self.run, self.complete)['status'], 'COMPLETE')
        self.assertTrue(all(not Path(p).exists() for p in self.config['sharedLocks']))

    def test_duplicate_never_runs_worker(self):
        c.on_success(self.config, self.run, self.complete)
        with patch.object(c, 'worker', side_effect=AssertionError('repeat')):
            self.assertEqual(c.on_success(self.config, self.run, lambda *_: self.fail())['status'], 'ALREADY_DELIVERED')

    def test_concurrent_duplicate_that_completed_before_lock_is_not_replayed(self):
        path, _ = c.enqueue(self.config, self.run)
        real = c.locks
        def complete_before_lock(paths, run):
            job = c.read(path)
            job['status'] = 'COMPLETE'
            c.save(path, job)
            return real(paths, run)
        with patch.object(c, 'locks', complete_before_lock):
            self.assertEqual(c.on_success(self.config, self.run, lambda *_: self.fail())['status'], 'ALREADY_DELIVERED')

    def test_four_lock_contentions_leave_foreign_files_untouched(self):
        for lock in self.config['sharedLocks']:
            c.save(lock, {'pid': 1})
            self.assertEqual(c.on_success(self.config, self.run, lambda *_: self.fail())['status'], 'QUEUED_LOCK_BUSY')
            self.assertEqual(c.read(lock), {'pid': 1})
            Path(lock).unlink()

    def test_race_after_gate_releases_own_partial_locks(self):
        real = c.locks
        def competing(paths, run):
            c.save(paths[2], {'pid': 1})
            return real(paths, run)
        with patch.object(c, 'locks', competing):
            self.assertEqual(c.on_success(self.config, self.run, self.complete)['status'], 'QUEUED_LOCK_BUSY')
        self.assertTrue(Path(self.config['sharedLocks'][2]).exists())
        self.assertTrue(all(not Path(p).exists() for i, p in enumerate(self.config['sharedLocks']) if i != 2))

    def test_cleanup_and_adoption_finish_while_wrapper_holds_no_locks(self):
        c.save(self.config['maintenanceState'], {'attempts': 60, 'runId': self.run, 'status': 'AWAITING_BODY_POST'})
        c.save(self.config['sharedLocks'][0], {'pid': 1})
        Path(self.config['adoptionRoot'], 'latest.json').unlink()
        ticks = [0]
        def sleep(_seconds):
            ticks[0] += 1
            if ticks[0] == 1:
                self.assertEqual(c.read(self.config['sharedLocks'][0]), {'pid': 1})
                Path(self.config['sharedLocks'][0]).unlink()
                c.save(self.config['maintenanceState'], {'attempts': 60, 'runId': self.run, 'status': 'PUBLISHED_POST_INCOMPLETE'})
            else:
                self.assertTrue(all(not Path(p).exists() for p in self.config['sharedLocks']))
                self.adopt(self.run)
        result = c.after_source(self.config, 60, 10, clock=lambda: ticks[0], sleep=sleep,
                                deliver=lambda cfg, run: c.on_success(cfg, run, self.complete))
        self.assertEqual(result['status'], 'COMPLETE')
        self.assertEqual(ticks[0], 2)

    def test_lock_absence_during_body_is_not_source_completion(self):
        c.save(self.config['maintenanceState'], {'attempts': 60, 'runId': self.run, 'status': 'AWAITING_BODY_POST'})
        self.assertEqual(c.after_source(self.config, 60, 0)['status'], 'WAITING_SOURCE_CLOSE')

    def test_failed_unpublished_source_is_not_delivered(self):
        c.save(self.config['maintenanceState'], {'attempts': 60, 'runId': self.run, 'status': 'FAILED'})
        self.assertEqual(c.after_source(self.config, 60, 0)['status'], 'SOURCE_NOT_PUBLISHED')

    def test_unallocated_source_and_cancelled_wait_do_not_deliver(self):
        self.assertEqual(c.after_source(self.config, 60, 0, cancelled=lambda: True)['status'], 'CANCELLED_NOT_DELIVERED')
        self.assertEqual(c.wait_for_delivery(self.config, self.run, 60, 0, cancelled=lambda: True)['status'], 'CANCELLED_NOT_DELIVERED')
        c.save(self.config['maintenanceState'], {'attempts': 59, 'status': 'PUBLISHED_POST_INCOMPLETE'})
        self.assertEqual(c.after_source(self.config, 60, 300, sleep=lambda *_: self.fail())['status'], 'SOURCE_NOT_STARTED')

    def test_old_or_missing_adoption_waits(self):
        self.adopt(str(uuid.uuid4()))
        self.assertEqual(c.adoption_gate(self.config, self.run), 'WAITING_ADOPTION')
        Path(self.config['adoptionRoot'], 'latest.json').unlink()
        self.assertEqual(c.adoption_gate(self.config, self.run), 'WAITING_ADOPTION')

    def test_adoption_pending_or_unverified_never_delivers(self):
        p = self.adopt(self.run)
        result = c.read(p)
        for key, value in [('locksReleased', False), ('exitCode', 4), ('outcome', 'commit-unknown')]:
            c.save(p, {**result, key: value})
            self.assertEqual(c.adoption_gate(self.config, self.run), 'REVIEW_REQUIRED')
        c.save(p, result)
        c.save(Path(self.config['adoptionRoot']) / 'pending-adoption.json', {'runId': self.run})
        self.assertEqual(c.adoption_gate(self.config, self.run), 'REVIEW_REQUIRED')

    def test_already_adopted_is_accepted(self):
        self.adopt(self.run, 'ALREADY_ADOPTED_VERIFIED')
        self.assertIsNone(c.adoption_gate(self.config, self.run))

    def test_adoption_scope_and_independent_reader_must_match(self):
        path = self.adopt(self.run)
        original = c.read(path)
        for section, key, value in [('owner', 'revision', '10'), ('owner', 'epoch', '7'),
                                    ('owner', 'configDigest', 'other-config'),
                                    ('reader', 'runId', str(uuid.uuid4())), ('reader', 'schemaDigest', 'other-schema')]:
            changed = json.loads(json.dumps(original))
            changed[section][key] = value
            c.save(path, changed)
            self.assertEqual(c.adoption_gate(self.config, self.run), 'REVIEW_REQUIRED')

    def test_incomplete_collection_is_not_eligible(self):
        path = Path(self.config['stateRoot']) / 'website-v2' / self.run / 'collection-private/index-private.json'
        c.save(path, {'runId': self.run, 'collectionComplete': False})
        with self.assertRaisesRegex(RuntimeError, 'VERIFIED_COMPLETE_SOURCE_REQUIRED'):
            c.on_success(self.config, self.run, lambda *_: self.fail())

    def test_older_completion_cannot_roll_back_newer_delivery(self):
        c.save(self.config['latestDeliveredFile'], {'sourceRunId': str(uuid.uuid4()), 'sourceFinishedAt': '2026-10-28T01:00:00Z'})
        self.assertEqual(c.on_success(self.config, self.run, lambda *_: self.fail())['status'], 'SUPERSEDED')

    def test_unverified_capture_rejected(self):
        path = Path(self.config['stateRoot']) / 'website-v2' / self.run / 'receipt-private.json'
        v = c.read(path)
        for key in ['published', 'readerVerified']:
            c.save(path, {**v, key: False})
            with self.assertRaisesRegex(RuntimeError, 'VERIFIED_COMPLETE_SOURCE_REQUIRED'):
                c.on_success(self.config, self.run, self.complete)

    def test_unknown_worker_outcome_retains_all_locks(self):
        def execute(_cfg, path):
            job = c.read(path)
            job.update(status='RUNNING', publicationRequested=True)
            c.save(path, job)
            raise subprocess.TimeoutExpired('fictional', 1)
        self.assertEqual(c.on_success(self.config, self.run, execute)['status'], 'WRITE_OUTCOME_UNKNOWN')
        self.assertTrue(all(Path(p).exists() for p in self.config['sharedLocks']))
        self.assertEqual(c.on_success(self.config, self.run, lambda *_: self.fail())['status'], 'WRITE_OUTCOME_UNKNOWN')

    def test_known_published_but_http_failed_does_not_rewrite(self):
        def execute(_cfg, path):
            job = c.read(path)
            job.update(status='PUBLISHED_HTTP_CHECK_PENDING', publicationRequested=True, published=True)
            c.save(path, job)
            return 1
        self.assertEqual(c.on_success(self.config, self.run, execute)['status'], 'PUBLISHED_HTTP_CHECK_PENDING')
        self.assertTrue(all(not Path(p).exists() for p in self.config['sharedLocks']))
        self.assertEqual(c.on_success(self.config, self.run, lambda *_: self.fail())['status'], 'PUBLISHED_HTTP_CHECK_PENDING')

    def test_crash_before_publication_is_failure_not_success(self):
        def fail(*_args):
            raise OSError('fictional')
        self.assertEqual(c.on_success(self.config, self.run, fail)['status'], 'FAILED_BEFORE_PUBLICATION')
        self.assertEqual(c.exit_code('FAILED_BEFORE_PUBLICATION'), 1)

    def test_exit_statuses_are_distinct(self):
        for statuses, expected in [(c.SUCCESS, 0), (c.WAITING, 75), (c.REVIEW, 3), (c.PUBLISHED, 4)]:
            for status in statuses:
                self.assertEqual(c.exit_code(status), expected)


class EntryTests(unittest.TestCase):
    setUp = DeliveryTests.setUp
    fixture = DeliveryTests.fixture
    adopt = DeliveryTests.adopt
    def request(self, code=0):
        script = self.root / 'run-round-60.py'
        script.write_text('import sys\nsys.exit(' + str(code) + ')\n')
        cfg = self.root / 'configuration.json'
        c.save(cfg, self.config)
        now = time.time()
        return {'enabled': True, 'attempt': 60, 'approvedAt': now, 'startNotAfter': now + 600,
                'source': {'python': sys.executable, 'script': str(script), 'cwd': str(self.root),
                           'arguments': ['user-reply:fictional approval\nexact unicode 原文 $() `literal`', str(int(now + 1000))]},
                'deliveryConfig': str(cfg), 'waitSeconds': 0, 'resultFile': str(self.root / 'result.json')}

    def test_original_arguments_environment_and_source_exit_are_preserved(self):
        request = self.request(27)
        script = Path(request['source']['script'])
        script.write_text("import sys,json,os\nfrom pathlib import Path\nPath('observed.json').write_text(json.dumps({'args':sys.argv[1:],'env':os.environ.get('FICTIONAL_ENTRY')}))\nsys.exit(27)\n")
        with patch.dict(os.environ, {'FICTIONAL_ENTRY': 'unchanged'}):
            code = entry.execute(request, finish=lambda *_a, **_k: {'status': 'COMPLETE'})
        self.assertEqual(code, 27)
        got = json.loads((self.root / 'observed.json').read_text())
        self.assertEqual(got['args'], request['source']['arguments'])
        self.assertEqual(got['env'], 'unchanged')

    def test_delivery_failure_does_not_replace_source_exit(self):
        for status in ['FAILED_BEFORE_PUBLICATION', 'WRITE_OUTCOME_UNKNOWN', 'WAITING_ADOPTION']:
            self.assertEqual(entry.execute(self.request(), finish=lambda *_a, **_k: {'status': status}), 0)
        def fail(*_args, **_kwargs):
            raise RuntimeError('FICTIONAL_POST_FAILURE')
        self.assertEqual(entry.execute(self.request(31), finish=fail), 31)

    def test_expired_or_extended_start_deadline_never_launches(self):
        request = self.request()
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_START_EXPIRED'):
            entry.execute(request, clock=lambda: request['startNotAfter'] + 1, popen=lambda *_a, **_k: self.fail())
        request['startNotAfter'] += 1
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_START_EXPIRED'):
            entry.validate(request, time.time())

    def test_round_before_trial_is_rejected(self):
        request = self.request()
        request['attempt'] = 59
        request['source']['script'] = str(self.root / 'run-round-59.py')
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_ENTRY_NOT_ELIGIBLE'):
            entry.execute(request, popen=lambda *_a, **_k: self.fail())

    def test_entry_holds_no_locks_while_source_runs(self):
        request = self.request()
        script = Path(request['source']['script'])
        paths = self.config['sharedLocks']
        script.write_text('from pathlib import Path\nimport json,os\npaths=' + repr(paths) + "\nassert all(not Path(p).exists() for p in paths)\nfor p in paths:Path(p).write_text('fictional')\nfor p in paths:Path(p).unlink()\n")
        self.assertEqual(entry.execute(request, finish=lambda *_a, **_k: {'status': 'WAITING_ADOPTION'}), 0)

    def test_only_delivery_child_owns_locks_not_the_wrapper(self):
        request = self.request()
        Path(request['source']['script']).write_text("import os\nfrom pathlib import Path\nPath('outer-pid.txt').write_text(str(os.getppid()))\n")
        worker = self.root / 'fictional-worker.py'
        worker.write_text('from pathlib import Path\nimport os,json,sys\nlocks=' + repr(self.config['sharedLocks'])
                          + "\nouter=int(Path('outer-pid.txt').read_text())\nassert all(json.loads(Path(p).read_text())['pid']==os.getppid()!=outer for p in locks)\np=Path(sys.argv[1]);v=json.loads(p.read_text());v['status']='COMPLETE';p.write_text(json.dumps(v))\n")
        self.config.update(repository=str(self.root), deliveryCommand=[sys.executable, str(worker)])
        c.save(request['deliveryConfig'], self.config)
        path = self.root / 'invocation.json'
        c.save(path, request)
        result = subprocess.run([sys.executable, '-B', str(CODE / 'sync-entry.py'), '--request', str(path)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(c.read(request['resultFile'])['delivery']['status'], 'COMPLETE')
        self.assertTrue(all(not Path(p).exists() for p in self.config['sharedLocks']))

    @unittest.skipUnless(os.name == 'posix', 'POSIX transport cancellation')
    def test_cancel_during_publication_preserves_unknown_locks_and_source_exit(self):
        request = self.request()
        worker = self.root / 'fictional-worker.py'
        worker.write_text("from pathlib import Path\nimport sys,json,time\np=Path(sys.argv[1]);v=json.loads(p.read_text());v.update(status='RUNNING',publicationRequested=True);p.write_text(json.dumps(v))\ntime.sleep(30)\n")
        self.config.update(repository=str(self.root), deliveryCommand=[sys.executable, str(worker)])
        c.save(request['deliveryConfig'], self.config)
        path = self.root / 'invocation.json'
        c.save(path, request)
        proc = subprocess.Popen([sys.executable, '-B', str(CODE / 'sync-entry.py'), '--request', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            until = time.monotonic() + 5
            while True:
                queued = list(Path(self.config['queueRoot']).glob('*.json'))
                if queued and c.read(queued[0]).get('publicationRequested'):
                    break
                self.assertIsNone(proc.poll())
                self.assertLess(time.monotonic(), until)
                time.sleep(0.02)
            proc.send_signal(signal.SIGTERM)
            out, err = proc.communicate(timeout=5)
            self.assertEqual(proc.returncode, 0, out + err)
            result = c.read(request['resultFile'])
            self.assertEqual(result['sourceExitCode'], 0)
            self.assertEqual(result['delivery']['status'], 'WRITE_OUTCOME_UNKNOWN')
            self.assertTrue(result['delivery']['locksRetained'])
            self.assertTrue(all(Path(p).exists() for p in self.config['sharedLocks']))
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.communicate()

    @unittest.skipUnless(os.name == 'posix', 'POSIX process/signal behavior')
    def test_cli_parent_command_line_does_not_expose_script_or_attempt(self):
        request = self.request()
        Path(request['source']['script']).write_text("import os,subprocess\nfrom pathlib import Path\np=subprocess.check_output(['ps','-p',str(os.getppid()),'-o','command='],text=True)\nPath('parent.txt').write_text(p)\n")
        path = self.root / 'invocation.json'
        c.save(path, request)
        completed = subprocess.run([sys.executable, '-B', str(CODE / 'sync-entry.py'), '--request', str(path)], capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        command = (self.root / 'parent.txt').read_text()
        self.assertNotIn('run-round-', command)
        import re
        self.assertFalse(re.search(r'(?<![0-9])60(?![0-9])', command))

    @unittest.skipUnless(os.name == 'posix', 'POSIX source signal status')
    def test_cli_preserves_source_termination_signal(self):
        request = self.request()
        Path(request['source']['script']).write_text('import os,signal\nos.kill(os.getpid(),signal.SIGTERM)\n')
        path = self.root / 'invocation.json'
        c.save(path, request)
        result = subprocess.run([sys.executable, '-B', str(CODE / 'sync-entry.py'), '--request', str(path)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, -signal.SIGTERM)


if __name__ == '__main__':
    unittest.main()
