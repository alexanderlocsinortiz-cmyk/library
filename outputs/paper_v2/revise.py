from pathlib import Path
root=Path(__file__).parent
p=root/'IBA_Library_System_REVISED.md'
s=p.read_text(encoding='utf-8')
replacements={
'How can students and teachers find book information by title, author, course or subject, availability, and shelf location without requiring an online account?':'How can students and teachers search books by title, author, or course/subject, filter by availability, and view shelf locations without an online account?',
'The final fieldwork record should state the interview or observation date, respondent role, actual forms or logs inspected, and any differences from this baseline.':'No interview date, respondent record, or completed observation instrument was supplied for this revision. The baseline therefore remains unverified.',
'The researchers should observe timeliness, accuracy, consistency, accessibility of information, and traceability.':'The planned assessment covers timeliness, accuracy, consistency, accessibility of information, and traceability.',
'For timeliness, record the time required to locate a book, record a checkout, record a return, and prepare a defined report. For accuracy, compare selected records with actual copy locations and loan states. For consistency, check whether the same eligibility and due-date rules are applied to comparable transactions.':'Timeliness measures cover book searches, checkout, return, and preparation of a defined report. Accuracy measures compare selected records with actual copy locations and loan states. Consistency measures examine whether equivalent transactions follow the same eligibility and due-date rules.',
'Record the number of observations and the sampling conditions; isolated examples should not be presented as the library\'s overall error rate.':'The number of observations and sampling conditions will accompany the results; isolated examples cannot establish an overall error rate.',
'It must not be represented as a confirmed formal queue unless the interview and record review establish that such a queue exists.':'The available evidence does not establish a formal existing queue.',
'The diagram groups closely related use cases for readability. Checkout includes borrower eligibility and copy-assignment checks; return includes loan closure and inventory reconciliation. These details are specified in Chapter 3 rather than presented as independent user goals.':'The diagram separates catalog access, personal-account actions, staff operations, and administrative functions into readable panels within the same system boundary. Checkout, return, lost/damaged closure, book-request management, and stock audit are distinct user goals. Checkout requires eligibility and copy-assignment checks; normal return requires loan closure and copy reconciliation, as specified in Chapter 3.',
'Figure 4. Core database relationships; arrows run from parent to child.':'Figure 4. Operational database relationships, including book requests and stock-audit records.',
'The defensible conclusion at this stage is that the design and prototype contain mechanisms aligned with the stated operational objectives.':'The design and prototype contain mechanisms aligned with the stated operational objectives.',
'Claims of achieved service improvement should be added only when those results are available.':'No measured service improvement is concluded from the present evidence.',
'Automatic overdue processing, renewal limits, pickup expiration, queue positions, barcode-input circulation, lost/damaged closure, book-request tracking, and stock-audit sessions should not be listed as wholly new future features because implementations already exist. Future work should extend or validate these capabilities rather than contradict the present scope.':'The recommendations extend the existing overdue processing, renewal controls, reservation queue, barcode-input circulation, lost/damaged closure, book-request tracking, and stock-audit functions. Their priority will depend on institutional policy and the results of user evaluation.'
}
for a,b in replacements.items():
 assert a in s,a
 s=s.replace(a,b)
s=s.replace('## Proposed Improvement\n','### Status of Existing-Process Evidence\n\n| Required evidence | Current status | Consequence for interpretation |\n| --- | --- | --- |\n| Interview record identifying date and respondent role | Not supplied | Institutional procedures are not yet confirmed. |\n| Actual forms, logbooks, or circulation records | Not supplied | The baseline cannot identify the exact recordkeeping instruments. |\n| Observed task times and discrepancy counts | Not supplied | No current delay or error rate can be reported. |\n| Confirmed circulation policies | Not supplied as an approved policy record | Implementation defaults remain provisional. |\n\n## Proposed Improvement\n')
s=s.replace('## Prototype Validation Requirements','## Prototype Validation Plan')
s=s.replace('# CHAPTER 6 — CONCLUSION AND RECOMMENDATIONS', '''## Evaluation Status and Recording Method

The current evidence consists of source inspection and interface screenshots rendered with synthetic responses. No completed institutional baseline comparison, live integration result set, or user-evaluation dataset was supplied for this revision. The following table records the evidence status explicitly; pending entries are not failed tests or passing results.

| Evaluation area | Measure and recording method | Result status |
| --- | --- | --- |
| Search and circulation time | Record elapsed time for the same task and equivalent records under manual and system-assisted conditions; report sample size and median per condition. | Not collected |
| Record accuracy | Count discrepancies among checked borrower, copy, loan, and hold records; report discrepancies divided by records checked and the sample size. | Not collected |
| Functional correctness | Record scenario, expected result, observed database state, outcome, and supporting evidence reference. | Controlled integration results not supplied |
| Access control | Record allowed/denied requests by role and ownership, including direct API requests, without exposing credentials. | Hosted verification results not supplied |
| Traceability | Check whether selected actions can be reconstructed from actor, timestamp, affected record, and audit details. | Not evaluated with operational records |
| Usability | Record participant role, task completion, observed errors, assistance required, and feedback under a consistent protocol. | Not collected |

The planned comparison uses equivalent tasks and documented conditions. Training, interruptions, device differences, and dataset differences are recorded because they may affect the interpretation of measured changes. The participant count and acceptance criteria have not yet been established with the adviser and library; they are not invented in this paper. The final conclusion will depend on the recorded results rather than on the presence of prototype features alone.

# CHAPTER 6 — CONCLUSION AND RECOMMENDATIONS''')
p.write_text(s,encoding='utf-8')

# Replace only diagram generation, retaining the document formatting and parser.
p=root/'build_paper.py';s=p.read_text(encoding='utf-8')
start=s.index('im,d=canvas(1600,1850)');end=s.index('\ndoc=Document()',start)
s=s[:start]+'''exec((ROOT/'diagrams_v2.py').read_text(encoding='utf-8'))
'''+s[end:]
p.write_text(s,encoding='utf-8')
