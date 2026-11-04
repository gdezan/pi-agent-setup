# Ownership and change scope

Limit extension changes to local extension resources maintained in this project, such as
`dotfiles/extensions/pi-footer/`. These are our source files, not externally installed extension
packages. See `package.json` and `manifest.json` for the resource declarations and external package
list.

Externally installed extension packages are outside this project's change scope, even when gdezan
owns them. Installing or configuring a package here does not make its source a local resource.

Treat Pi core and every external package listed under `packages` in `manifest.json` as read-only. Do
not patch, fork, vendor, or replace them, including their installed copies or separate checkouts. If
a fix requires an external change, report the evidence and the upstream dependency instead of
implementing it here.

When diagnosing terminal corruption, distinguish our extension code from external writers. Attribute
the problem to Pi core only with a matching GitHub issue and local evidence; a stack trace appearing
in Pi's input area alone is not enough.
