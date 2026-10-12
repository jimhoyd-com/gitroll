# Writes synthetic-1password.1pux: a 1Password 1PUX export built from the
# documented layout (export.attributes, export.data, files/). Synthetic values only.
import json, zipfile
items = [
  {"uuid": "synthlogin0000000000000001", "favIndex": 0, "createdAt": 1700000000, "updatedAt": 1700000500, "state": "active", "categoryUuid": "001",
   "details": {"loginFields": [
       {"value": "ada@example.com", "id": "", "name": "email", "fieldType": "E", "designation": "username"},
       {"value": "synthetic-1p-password", "id": "", "name": "password", "fieldType": "P", "designation": "password"}],
     "notesPlain": "Synthetic login notes",
     "sections": [{"title": "Security", "name": "sec", "fields": [
         {"title": "one-time password", "id": "TOTP_1", "value": {"totp": "otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP"}, "guarded": False},
         {"title": "recovery key", "id": "rk", "value": {"concealed": "SYNTH-RECOVERY"}},
         {"title": "member since", "id": "since", "value": {"date": 1600000000}},
         {"title": "receipt", "id": "f1", "value": {"file": {"fileName": "receipt.pdf", "documentId": "d1"}}},
         {"title": "weird", "id": "w", "value": {"futureType": {"x": 1}}}]}],
     "passwordHistory": [{"value": "synthetic-old-1p", "time": 1690000000}]},
   "overview": {"subtitle": "ada@example.com", "urls": [{"label": "", "url": "https://login.example.com"}, {"label": "admin", "url": "https://admin.example.com"}], "title": "Example Login", "url": "https://login.example.com", "tags": ["work"]}},
  {"uuid": "synthcard00000000000000001", "createdAt": 1700000000, "updatedAt": 1700000000, "state": "active", "categoryUuid": "002",
   "details": {"loginFields": [], "notesPlain": "", "sections": [{"title": "", "name": "", "fields": [
       {"title": "cardholder name", "id": "cardholder", "value": {"string": "Ada Example"}},
       {"title": "number", "id": "ccnum", "value": {"creditCardNumber": "4111111111111111"}},
       {"title": "verification number", "id": "cvv", "value": {"concealed": "123"}},
       {"title": "expiry date", "id": "expiry", "value": {"monthYear": 202912}},
       {"title": "address", "id": "addr", "value": {"address": {"street": "1 Synthetic St", "city": "Exampleton", "state": "", "zip": "00000", "country": "us"}}}]}]},
   "overview": {"title": "Synthetic Visa", "tags": []}},
  {"uuid": "synthssh000000000000000001", "createdAt": 1700000000, "updatedAt": 1700000000, "state": "active", "categoryUuid": "114",
   "details": {"loginFields": [], "sections": [{"title": "", "fields": [
       {"title": "private key", "id": "private_key", "value": {"sshKey": {"privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----\n", "metadata": {"publicKey": "ssh-ed25519 AAAAsynthetic", "fingerprint": "SHA256:x", "keyType": "ed25519"}}}}]}]},
   "overview": {"title": "Deploy SSH key"}},
  {"uuid": "synthnote00000000000000001", "createdAt": 1700000000, "updatedAt": 1700000000, "state": "archived", "categoryUuid": "003",
   "details": {"notesPlain": "archived synthetic note"}, "overview": {"title": "Old note"}},
  {"uuid": "synthdoc000000000000000001", "createdAt": 1700000000, "updatedAt": 1700000000, "state": "active", "categoryUuid": "006",
   "details": {"documentAttributes": {"fileName": "passport.pdf", "documentId": "d2"}}, "overview": {"title": "Passport scan"}},
]
data = {"accounts": [{"attrs": {"accountName": "Synthetic", "name": "Ada", "email": "ada@example.com", "uuid": "acct", "domain": "https://example.1password.com/"},
                      "vaults": [{"attrs": {"uuid": "v1", "desc": "", "avatar": "", "name": "Personal", "type": "P"}, "items": items}]}]}
with zipfile.ZipFile("synthetic-1password.1pux", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("export.attributes", json.dumps({"version": 3, "description": "1Password Unencrypted Export", "createdAt": 1700001000}))
    z.writestr("export.data", json.dumps(data, indent=2))
    z.writestr("files/d1__receipt.pdf", b"synthetic file")
