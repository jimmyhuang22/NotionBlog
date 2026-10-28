"""Explicit delivery of one already published version; never starts a source."""
import argparse
from pathlib import Path
import json
import os
import signal
import sys
from completion import exit_code, need, on_success, read


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    config = read(args.config)
    need(config.get('enabled') is True and config.get('scheduled') is False, 'DELIVERY_NOT_ENABLED')
    result = on_success(config, args.run_id)
    print(json.dumps(result))
    return exit_code(result['status'])


if __name__ == '__main__':
    os.umask(0o077)
    def cancel(_sig, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, cancel)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        value = {'status': 'REVIEW_REQUIRED', 'reason': 'CANCELLED_CHECK_QUEUE'}
        try:
            args = sys.argv
            config = read(args[args.index('--config') + 1])
            run = args[args.index('--run-id') + 1]
            job = read(Path(config['queueRoot']) / (run + '.json'))
            value.update(status=job['status'], sourceRunId=run,
                         locksRetained=any(Path(p).exists() and read(p).get('pid') == os.getpid() for p in config['sharedLocks']))
        except Exception:
            pass
        print(json.dumps(value))
        sys.exit(exit_code(value['status']))
    except Exception as error:
        print(json.dumps({'status': 'POST_SYNC_FAILED', 'reason': str(error) if str(error).isupper() else type(error).__name__}))
        sys.exit(1)
