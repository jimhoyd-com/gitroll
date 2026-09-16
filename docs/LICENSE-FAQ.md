# License questions

From version 0.3.0, GitRoll is under the [PolyForm Shield License 1.0.0](../LICENSE). Versions up to and including 0.2.0 were under the MIT License and stay that way permanently ([LICENSE-MIT-HISTORICAL](../LICENSE-MIT-HISTORICAL)).

GitRoll is **source available**, not open source. The source is public and you can read it, change it and share it. One purpose is carved out: you may not use GitRoll to provide a product that competes with GitRoll or with GitRoll.com.

This page is a plain-language guide to what that means in practice. It isn't the license and it isn't legal advice — where this page and the [LICENSE](../LICENSE) disagree, the LICENSE is what counts. If your situation isn't here, ask: **jimhoyd@gmail.com**.

## Can I use GitRoll at work?

Yes, in a company of any size, free, and without asking anyone. Using GitRoll inside a business for that business's own work is fine.

## I'm a consultant. Can I log billable client work in it?

Yes. Using GitRoll as a tool in work you charge for is free.

The line isn't about whether you make money. It's about whether what you sell competes with GitRoll.

## Can I fork it and publish my changes?

Yes. Read it, change it, fork it, publish the fork.

Two conditions, both from the license: pass the license on with it, including the `Required Notice:` and `Licensor Line of Business:` lines at the top of [LICENSE](../LICENSE), and don't use it to provide a competing product.

## Can I run a shared GitRoll web app for my team?

For people inside your own organisation, yes — that's internal use.

If you'd be offering it to anyone outside your organisation, paid or free, that starts to resemble GitRoll.com and you should ask first. Email **jimhoyd@gmail.com** and describe what you want to do. This is the question most worth asking rather than guessing at, and the answer is usually yes.

## Is GitRoll still open source?

No. PolyForm Shield doesn't meet the Open Source Definition, so describing GitRoll as open source would be inaccurate.

It is source available: public source, free to use for nearly everything, with one restriction.

## Can't someone fork 0.2.0 and carry on under MIT?

Yes. That's a real answer, not a loophole being glossed over.

0.1.0, 0.1.1, 0.1.2 and 0.2.0 were published under the MIT License. That grant is permanent and can't be revoked. What such a fork wouldn't get is anything released from 0.3.0 onward.

## Will the old MIT releases be deleted?

No. They stay published at <https://github.com/jimhoyd-com/gitroll/releases>.

Removing them would look like an attempt to revoke a grant that can't be revoked, and it wouldn't work anyway.

## What happens if GitRoll is abandoned, or sold?

Being straight about this, because the license is more restrictive here than people expect.

PolyForm Shield lets you compete with a product the licensor has *stopped* providing — but not when the licensor has named that line of business in the license. GitRoll.com is named, in the `Licensor Line of Business:` line in [LICENSE](../LICENSE). So GitRoll.com shutting down would not by itself release the restriction. Shield also lets a buyer enforce the noncompete if the business is sold.

What actually protects you is the format, not the license. A Roll is plain Markdown files in a Git repository you own, the format is written down in [SPEC.md](../SPEC.md), and a text editor reads it. If GitRoll disappeared tomorrow, your logbook would still work.

## Does this affect my Rolls?

No, and it can't.

The license covers the app. Your Roll is your files in your repository. Nothing here changes what's in it, who can read it, or your ability to open it with or without GitRoll.

## Why not AGPL, or BSL?

AGPL is a genuine open source license, and using copyleft as a commercial lever rather than a freedom guarantee would be a misuse of it — and it wouldn't stop a competitor who complied with its terms.

BSL is time-delayed: every version eventually becomes open source, which doesn't fit a restriction that needs to last.

PolyForm Shield says the intended thing directly, in about a page of readable English, and it's a license other people have already reviewed.

## Why Shield rather than PolyForm Perimeter?

They're close, and the difference decides this case.

Perimeter's noncompete covers products that compete **with the software**. Shield's covers products that compete with the software **or with any product the licensor provides using the software** — which reaches GitRoll.com, a different product from the app itself.

## I want to do something the license doesn't allow

Email **jimhoyd@gmail.com** and say what you have in mind. Commercial licenses are available.

## I want to contribute

Please read [Contribution terms](../CONTRIBUTING.md#contribution-terms) first. They aren't the usual "inbound = outbound": contributors grant a license broad enough that contributed code can ship in both GitRoll and GitRoll.com, while keeping their own copyright.

If you'd rather not agree to that, open an issue instead of a pull request. Bug reports, format discussion and documentation fixes are just as welcome, and none of it applies to them.
