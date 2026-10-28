"""Use --request PRIVATE_JSON; source arguments never appear in this process argv."""
from pathlib import Path
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from completion import need, read, save, after_source, exit_code


def validate(request, now):
    need(request.get('enabled') is True, 'ENTRY_NOT_ENABLED')
    source = request['source']
    script = Path(source['script'])
    match = re.fullmatch(r'run-round-([0-9]+)\.py', script.name)
    need(match and int(match[1]) >= 60 and int(match[1]) == request['attempt'], 'SOURCE_ENTRY_NOT_ELIGIBLE')
    need(script.is_absolute() and script.resolve() == script and script.is_file(), 'SOURCE_SCRIPT')
    need(Path(source['python']).is_absolute() and Path(source['cwd']).is_absolute(), 'SOURCE_PATHS')
    args = source['arguments']
    need(isinstance(args, list) and 1 <= len(args) <= 2
         and all(isinstance(x, str) for x in args)
         and args[0].startswith('user-reply:') and len(args[0]) > 20, 'ORIGINAL_APPROVAL_REQUIRED')
    # No recomputed authority, injected approval, counter change or source retry.
    need(request['startNotAfter'] == request['approvedAt'] + 600
         and request['approvedAt'] <= now <= request['startNotAfter'], 'SOURCE_START_EXPIRED')
    need(0 <= request.get('waitSeconds', 300) <= 1800, 'WAIT_LIMIT')
    return [source['python'], '-B', str(script), *args]


def execute(request, popen=subprocess.Popen, clock=time.time, finish=after_source):
    argv = validate(request, clock())
    cancelled = False
    child = None
    old = {}

    def forward(sig, _frame):
        nonlocal cancelled
        cancelled = True
        if child and child.poll() is None:
            try:
                os.killpg(child.pid, sig)
            except ProcessLookupError:
                pass

    def delivery(config, run):
        nonlocal child
        if cancelled:
            return {'status': 'CANCELLED_NOT_DELIVERED', 'sourceRunId': run}
        # Only this separate delivery process may own coordination locks.
        child = subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('delivery.py')),
                                  '--config', request['deliveryConfig'], '--run-id', run],
                                 stdout=subprocess.PIPE, text=True, start_new_session=True)
        text, _ = child.communicate()
        need(len(text) <= 1024 * 1024, 'DELIVERY_RESULT_SIZE')
        value = json.loads(text)
        need(child.returncode == exit_code(value['status']), 'DELIVERY_EXIT_MISMATCH')
        return value

    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            old[sig] = signal.signal(sig, forward)
        # The source gets its original argv, environment, stdout/stderr and own
        # process group. This wrapper holds none of the four coordination locks.
        need(clock() <= request['startNotAfter'], 'SOURCE_START_EXPIRED')
        child = popen(argv, cwd=request['source']['cwd'], start_new_session=True)
        code = child.wait()
        result = {'status': 'SOURCE_EXITED', 'sourceExitCode': code, 'delivery': None}
        try:
            if not cancelled:
                c = read(request['deliveryConfig'])
                result['delivery'] = finish(c, request['attempt'], request.get('waitSeconds', 300),
                                            deliver=delivery, cancelled=lambda: cancelled)
            else:
                result['delivery'] = {'status': 'CANCELLED_NOT_DELIVERED'}
            save(request['resultFile'], result)
        except Exception as error:
            result['delivery'] = {'status': 'ENTRY_POST_FAILED', 'reason': str(error) if str(error).isupper() else type(error).__name__}
            try:
                save(request['resultFile'], result)
            except Exception:
                pass
        # The source exit code is deliberately independent of delivery status.
        print(json.dumps(result), flush=True)
        return code
    finally:
        for sig, handler in old.items():
            signal.signal(sig, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    args = parser.parse_args()
    request = read(args.request)
    # Keep this process invisible to source cleanup's command-name matching.
    pattern = r'run-round-|(?<![0-9])' + re.escape(str(request['attempt'])) + r'(?![0-9])'
    need(not re.search(pattern, ' '.join(sys.argv)), 'ENTRY_ARGV_EXPOSES_SOURCE')
    return execute(request)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        rc = main()
    except Exception as error:
        # No raw source args/approval/credentials in a failure message.
        print(json.dumps({'status': 'ENTRY_FAILED', 'reason': str(error) if str(error).isupper() else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
    if rc < 0:
        signal.signal(-rc, signal.SIG_DFL)
        os.kill(os.getpid(), -rc)
    sys.exit(rc)
