# Capture expiry compatibility fixtures

These two public source files preserve the exact executable bytes for the reviewed expiry-only producer/consumer transition. They let the host recovery tests run from a clean checkout without fetching legacy Git objects. They contain source code only, with no runtime inputs or captured content.

| File | Historical source revision | SHA-256 |
| --- | --- | --- |
| `producer-worker.ts.txt` | `99352be4a5ce92735fd7f1560ab28689c0c3a300` | `9a302db7b9eaba3b7a7cd1fdc99afbe0c81fe284964d3d7bf3e5285c5642be1f` |
| `consumer-worker.ts.txt` | `6760363e13c96e616c8616e0502b9191dbacdaea` | `b9ccf53f3c08b1aa785f895cd76c6c4b78d64efa4999399fc0ea7b14684992be` |

The production compatibility verifier pins both hashes. Keep these fixture bytes unchanged; the tests still exercise both qualification modes, producer tampering, capture-index tampering and the parent/child recovery boundary.
