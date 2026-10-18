## Mandatory Review Rules (always apply)

Always review the diff against these three mandatory focuses, in addition to any
language-specific rules below. Report every concrete finding with file path, line
range, severity, and a concrete fix suggestion.

1. Security & secrets exposure: flag hardcoded credentials, API keys, tokens,
   passwords, or PII (phone numbers, ID-card numbers, emails); flag internal IPs,
   internal domains and company-private information that would leak when the
   repository is published; flag security vulnerabilities such as SQL injection,
   XSS, path traversal, and missing auth/permission checks.
2. Correctness bugs: logic errors, missing boundary conditions, improper exception
   handling, race conditions in concurrent code, and resource leaks.
3. Redundancy & scope creep: dead code, unused imports or references, duplicated
   logic, and changes unrelated to what the diff claims to do.

Write "N/A" for a focus only when it has nothing to flag for a specific file.
