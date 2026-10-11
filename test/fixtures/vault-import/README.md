# Vault import fixtures

Synthetic files for `test/vault-interop.test.ts`. Every value in them is made up.

| File | Made by | Password |
| --- | --- | --- |
| `keepass-argon2d-aes.kdbx` | pykeepass 4.2.0, `make-kdbx.py`: KDBX 4.0, Argon2d, AES-256, gzip | `synthetic-kdbx-password` |
| `keepass-aeskdf-chacha20.kdbx` | the same, re-saved with AES-KDF and ChaCha20 | `synthetic-kdbx-password` |
| `synthetic-1password.1pux` | `make-1pux.py`, from 1Password's documented 1PUX layout, not from the 1Password app | none (1PUX is plain text) |

The KeePass files come from an implementation other than GitRoll's, so reading
them tests interoperability, not just a round trip. The 1PUX file is only as
faithful as the published layout; a real export may carry fields it lacks.
