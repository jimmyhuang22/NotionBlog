"""Foreground completion delivery. No source collection, adoption or scheduler here."""
from pathlib import Path
import contextlib
import datetime
import json
import os
import signal
import stat
import subprocess
import time
import uuid

SUCCESS = {'COMPLETE', 'ALREADY_DELIVERED', 'SUPERSEDED'}
WAITING = {'QUEUED_LOCK_BUSY', 'WAITING_SOURCE_CLOSE', 'WAITING_ADOPTION'}
REVIEW = {'WRITE_OUTCOME_UNKNOWN', 'REVIEW_REQUIRED'}
PUBLISHED = {'PUBLISHED_HTTP_CHECK_PENDING', 'PUBLISHED_VERIFICATION_FAILED'}
SOURCE_PUBLISHED = {'PASS', 'PUBLISHED', 'PUBLISHED_POST_INCOMPLETE'}
ADOPTED = {'ADOPTED_VERIFIED', 'ALREADY_ADOPTED_VERIFIED'}


def need(ok, code):
    if not ok:
        raise RuntimeError(code)


def read(path, limit=16 * 1024 * 1024):
    p = Path(path)
    s = p.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == os.getuid()
         and stat.S_IMODE(s.st_mode) == 0o600 and s.st_size <= limit, 'PRIVATE_FILE')
    return json.loads(p.read_text())


def save(path, value):
    p = Path(path)
    p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = p.with_name('.tmp-' + str(uuid.uuid4()))
    try:
        with tmp.open('x') as f:
            os.chmod(tmp, 0o600)
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    finally:
        tmp.unlink(missing_ok=True)


def run_id(run):
    need(str(uuid.UUID(run)) == run, 'RUN_ID')
    return run


def timestamp(value):
    dt = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    need(dt.tzinfo is not None, 'SOURCE_FINISH_TIME')
    return dt.timestamp()


def exit_code(status):
    if status in SUCCESS:
        return 0
    if status in WAITING:
        return 75
    if status in REVIEW:
        return 3
    if status in PUBLISHED:
        return 4
    return 1


def capture(c, run):
    run_id(run)
    root = Path(c['stateRoot']) / 'website-v2' / run
    receipt = read(root / 'receipt-private.json')
    index = read(root / 'collection-private/index-private.json')
    need(receipt.get('runId') == index.get('runId') == run
         and receipt.get('published') is True and receipt.get('readerVerified') is True
         and index.get('collectionComplete') is True, 'VERIFIED_COMPLETE_SOURCE_REQUIRED')
    timestamp(receipt['finishedAt'])
    return receipt


def source_gate(c, run, attempt=None):
    state = read(c['maintenanceState'])
    if attempt is not None and state.get('attempts') != attempt:
        return 'WAITING_SOURCE_CLOSE'
    if state.get('status') == 'FAILED':
        return 'SOURCE_NOT_PUBLISHED'
    if state.get('runId') != run or state.get('status') not in SOURCE_PUBLISHED:
        return 'WAITING_SOURCE_CLOSE'
    # A missing maintenance lock during a body phase is insufficient: state and
    # the original child exit must also be known. Never remove another lock.
    if any(os.path.lexists(p) for p in c['sharedLocks']):
        return 'QUEUED_LOCK_BUSY'
    capture(c, run)
    return None


def adoption_gate(c, run):
    need(set(c['adoptionExpected']) == {'revision', 'epoch', 'configDigest', 'schemaDigest'}, 'ADOPTION_EXPECTATIONS_REQUIRED')
    root = Path(c['adoptionRoot'])
    if os.path.lexists(root / 'pending-adoption.json'):
        return 'REVIEW_REQUIRED'
    try:
        latest = read(root / 'latest.json')
    except FileNotFoundError:
        return 'WAITING_ADOPTION'
    if latest.get('runId') != run:
        return 'WAITING_ADOPTION'
    if latest.get('status') not in ADOPTED or latest.get('exitCode') != 0:
        return 'REVIEW_REQUIRED'
    path = Path(latest['receipt'])
    need(path.resolve() == path and path.name == 'result.json'
         and path.is_relative_to(root / 'runs'), 'ADOPTION_RESULT_PATH')
    result = read(path)
    if (result.get('targetRun') != run or result.get('status') != latest['status']
            or result.get('exitCode') != 0 or result.get('locksReleased') is not True
            or result.get('outcome') in {'commit-unknown', 'write-unverified'}):
        return 'REVIEW_REQUIRED'
    owner, reader = result.get('owner') or {}, result.get('reader') or {}
    if (owner.get('runId') != run or reader.get('runId') != run
            or owner.get('outcome') in {'commit-unknown', 'write-unverified'}
            or not (owner.get('committed') is True or owner.get('reusedExisting') is True)):
        return 'REVIEW_REQUIRED'
    for key, value in c['adoptionExpected'].items():
        if str(owner.get(key)) != str(value):
            return 'REVIEW_REQUIRED'
    if (str(reader.get('revision')) != str(owner.get('revision'))
            or reader.get('schemaDigest') != owner.get('schemaDigest')):
        return 'REVIEW_REQUIRED'
    return None


@contextlib.contextmanager
def locks(paths, run):
    owned, state = [], {'retain': False}
    try:
        for path in paths:
            p = Path(path)
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump({'pid': os.getpid(), 'runId': run, 'kind': 'self-hosted-delivery'}, f)
                f.flush()
                os.fsync(f.fileno())
                s = os.fstat(f.fileno())
            owned.append((p, s.st_dev, s.st_ino))
        yield state
    finally:
        if not state['retain']:
            for p, dev, ino in reversed(owned):
                s = p.lstat()
                need((s.st_dev, s.st_ino) == (dev, ino)
                     and read(p).get('pid') == os.getpid(), 'LOCK_CHANGED')
                p.unlink()


def enqueue(c, run):
    receipt = capture(c, run)
    path = Path(c['queueRoot']) / (run + '.json')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    job = {'sourceRunId': run, 'sourceFinishedAt': receipt['finishedAt'],
           'targetRunId': str(uuid.uuid4()), 'status': 'QUEUED', 'sourceRequests': 0}
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(job, f)
            f.flush()
            os.fsync(f.fileno())
    except FileExistsError:
        job = read(path)
    return path, job


def worker(c, path):
    """Private control logs; timeout terminates the whole transport group."""
    with path.with_suffix('.stdout.log').open('wb') as out, path.with_suffix('.stderr.log').open('wb') as err:
        os.chmod(out.name, 0o600)
        os.chmod(err.name, 0o600)
        child = subprocess.Popen([*c['deliveryCommand'], str(path)], cwd=c['repository'],
                                 env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'NODE_ENV': 'production'},
                                 stdout=out, stderr=err, start_new_session=True)
        try:
            return child.wait(timeout=c.get('deliveryTimeout', 1800))
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise


def on_success(c, run, execute=worker):
    need(c.get('enabled') is True and c.get('scheduled') is False, 'DELIVERY_NOT_ENABLED')
    need(len(c['sharedLocks']) == 4 and len(set(c['sharedLocks'])) == 4, 'FOUR_SHARED_LOCKS_REQUIRED')
    path, job = enqueue(c, run)
    if job['status'] in SUCCESS:
        return {'status': 'ALREADY_DELIVERED', 'sourceRunId': run}
    if job['status'] in REVIEW | PUBLISHED | {'RUNNING'}:
        return {'status': 'REVIEW_REQUIRED' if job['status'] == 'RUNNING' else job['status'], 'sourceRunId': run}
    latest_file = Path(c['latestDeliveredFile'])
    if latest_file.exists():
        previous = read(latest_file)
        if previous['sourceRunId'] != run and timestamp(previous['sourceFinishedAt']) >= timestamp(job['sourceFinishedAt']):
            return {'status': 'SUPERSEDED', 'sourceRunId': run}
    gate = source_gate(c, run) or adoption_gate(c, run)
    if gate:
        return {'status': gate, 'sourceRunId': run}
    try:
        with locks(c['sharedLocks'], job['targetRunId']) as owned:
            job = read(path)
            if job['status'] in SUCCESS:
                return {'status': 'ALREADY_DELIVERED', 'sourceRunId': run}
            if job['status'] in REVIEW | PUBLISHED | {'RUNNING'}:
                return {'status': 'REVIEW_REQUIRED' if job['status'] == 'RUNNING' else job['status'], 'sourceRunId': run}
            # Recheck after acquiring all four locks: adoption/cleanup can win
            # the race while the wrapper is merely waiting without any lock.
            state = read(c['maintenanceState'])
            need(state.get('runId') == run and state.get('status') in SOURCE_PUBLISHED, 'SOURCE_CHANGED')
            need(adoption_gate(c, run) is None, 'ADOPTION_CHANGED')
            need(capture(c, run)['finishedAt'] == job['sourceFinishedAt'], 'SOURCE_RECEIPT_CHANGED')
            latest_file = Path(c['latestDeliveredFile'])
            if latest_file.exists():
                previous = read(latest_file)
                if previous['sourceRunId'] != run and timestamp(previous['sourceFinishedAt']) >= timestamp(job['sourceFinishedAt']):
                    job['status'] = 'SUPERSEDED'
                    save(path, job)
                    return {'status': 'SUPERSEDED', 'sourceRunId': run}
            try:
                code = execute(c, path)
                final = read(path)
                if final['status'] not in SUCCESS | REVIEW | PUBLISHED | {'FAILED_KNOWN_NOT_PUBLISHED', 'FAILED_BEFORE_PUBLICATION'}:
                    final['status'] = ('WRITE_OUTCOME_UNKNOWN' if final.get('publicationRequested')
                                       and final['status'] == 'RUNNING' else 'FAILED_BEFORE_PUBLICATION')
                    save(path, final)
            except BaseException as error:
                final = read(path)
                # A worker can die after the server committed. Preserve its
                # already confirmed published outcome, never downgrade it.
                if final['status'] not in SUCCESS | PUBLISHED:
                    final['status'] = ('WRITE_OUTCOME_UNKNOWN' if final.get('publicationRequested')
                                       else 'FAILED_BEFORE_PUBLICATION')
                    save(path, final)
                owned['retain'] = final['status'] == 'WRITE_OUTCOME_UNKNOWN'
                if isinstance(error, (KeyboardInterrupt, SystemExit)):
                    raise
                code = 1
            owned['retain'] = final['status'] == 'WRITE_OUTCOME_UNKNOWN'
            if final['status'] in SUCCESS:
                save(latest_file, {'sourceRunId': run, 'sourceFinishedAt': job['sourceFinishedAt'],
                                   'targetRunId': job['targetRunId']})
            return {'status': final['status'], 'sourceRunId': run,
                    'workerExitCode': code, 'locksRetained': owned['retain']}
    except FileExistsError:
        return {'status': 'QUEUED_LOCK_BUSY', 'sourceRunId': run}


def wait_for_delivery(c, run, attempt, seconds, clock=time.monotonic, sleep=time.sleep, deliver=on_success, cancelled=lambda: False):
    """Foreground only. No source re-run, adoption command or lock acquisition."""
    until = clock() + seconds
    while True:
        if cancelled():
            return {'status': 'CANCELLED_NOT_DELIVERED', 'sourceRunId': run}
        gate = source_gate(c, run, attempt) or adoption_gate(c, run)
        result = {'status': gate, 'sourceRunId': run} if gate else deliver(c, run)
        if result['status'] not in WAITING or clock() >= until:
            return result
        sleep(min(2, max(0, until - clock())))


def after_source(c, attempt, seconds, clock=time.monotonic, sleep=time.sleep, deliver=on_success, cancelled=lambda: False):
    """Pin the run only after Claude has closed the round, not mid-cleanup."""
    need(c.get('enabled') is True and c.get('scheduled') is False, 'DELIVERY_NOT_ENABLED')
    until = clock() + seconds
    while True:
        if cancelled():
            return {'status': 'CANCELLED_NOT_DELIVERED'}
        state = read(c['maintenanceState'])
        if state.get('attempts', 0) < attempt:
            return {'status': 'SOURCE_NOT_STARTED'}
        if state.get('attempts') == attempt:
            if state.get('status') == 'FAILED':
                return {'status': 'SOURCE_NOT_PUBLISHED'}
            if state.get('status') in SOURCE_PUBLISHED and state.get('runId'):
                return wait_for_delivery(c, state['runId'], attempt, max(0, until - clock()), clock, sleep, deliver, cancelled)
        if state.get('attempts', 0) > attempt:
            return {'status': 'REVIEW_REQUIRED', 'reason': 'SOURCE_VERSION_MOVED'}
        if clock() >= until:
            return {'status': 'WAITING_SOURCE_CLOSE'}
        sleep(min(2, max(0, until - clock())))
