# Writes the two KeePass fixtures with pykeepass 4.2.0 (an independent KDBX
# implementation), so GitRoll's reader is tested against files it didn't write.
# Synthetic values only. The key derivation is turned down so tests stay fast.
#   python3 make-kdbx.py
import os
from construct import Container
from pykeepass import PyKeePass, create_database

PW = "synthetic-kdbx-password"
db = create_database("big.kdbx", password=PW)
email = db.add_group(db.root_group, "Email")
e = db.add_entry(email, "Example Mail", "ada@example.com", "synthetic-mail-password", url="https://mail.example.com", notes="Synthetic notes\nline two", tags=["work", "mail"])
e.set_custom_property("Recovery code", "SYNTH-1111-2222", protect=True)
e.set_custom_property("Account number", "4417", protect=False)
e.otp = "otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example"
e.save_history()
e.password = "synthetic-mail-password-2"
e.add_attachment(db.add_binary(b"synthetic attachment"), "readme.txt")
db.add_entry(db.root_group, "Wi-Fi & <home>", "", "synthetic-wifi-pass")
db.add_entry(db.root_group, "Just a note", "", "", notes="Only notes here")
db.trash_entry(db.add_entry(db.root_group, "Old login", "old", "synthetic-old"))
db.save()

# Argon2d + AES-256 (pykeepass's defaults), with 1 MiB and 2 passes.
db = PyKeePass("big.kdbx", password=PW)
kdf = db.kdbx.header.value.dynamic_header.kdf_parameters.data.dict
kdf["I"].value, kdf["M"].value = 2, 1024 * 1024
db.save("keepass-argon2d-aes.kdbx", transformed_key=None)

# AES-KDF (1000 rounds) + ChaCha20.
db = PyKeePass("keepass-argon2d-aes.kdbx", password=PW)
h = db.kdbx.header.value.dynamic_header
h.cipher_id.data = "chacha20"
h.encryption_iv.data = os.urandom(12)
kdf = h.kdf_parameters.data.dict
kdf["$UUID"].value = bytes.fromhex("c9d9f39a628a4460bf740d08c18a4fea")
for k in ["I", "M", "P", "V"]:
    del kdf[k]
kdf["S"].next_byte = 5
kdf["R"] = Container(type=5, key="R", value=1000, next_byte=0)
db.save("keepass-aeskdf-chacha20.kdbx", transformed_key=None)
os.remove("big.kdbx")
