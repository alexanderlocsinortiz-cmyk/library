-- Illustrative catalog records for IBACMI's published academic programs.
-- These are sample references, not verified library holdings. No physical
-- copies are seeded, so the records cannot be checked out as available stock.
with sample_books(title, author, category, course_subject) as (
  values
    ('Database System Concepts', 'Abraham Silberschatz, Henry F. Korth, S. Sudarshan', 'Information Technology', 'BSIT / Database Management'),
    ('Computer Networking: A Top-Down Approach', 'James F. Kurose, Keith W. Ross', 'Information Technology', 'BSIT / Computer Networks'),
    ('Criminology: The Core', 'Larry J. Siegel', 'Criminology', 'BS Criminology / Criminology'),
    ('Criminal Justice: A Brief Introduction', 'Frank Schmalleger', 'Criminology', 'BS Criminology / Criminal Justice'),
    ('Entrepreneurship: Successfully Launching New Ventures', 'Bruce R. Barringer, R. Duane Ireland', 'Entrepreneurship', 'BS Entrepreneurship / Entrepreneurship'),
    ('The Lean Startup', 'Eric Ries', 'Entrepreneurship', 'BS Entrepreneurship / New Venture Creation'),
    ('Public Administration: Understanding Management, Politics, and Law in the Public Sector', 'David H. Rosenbloom, Robert S. Kravchuk, Richard M. Clerkin', 'Public Administration', 'BPA / Public Administration'),
    ('Public Policy: Politics, Analysis, and Alternatives', 'Michael E. Kraft, Scott R. Furlong', 'Public Administration', 'BPA / Public Policy'),
    ('Educational Psychology', 'Anita Woolfolk', 'Elementary Education', 'BEED / Educational Psychology'),
    ('The Skillful Teacher: On Technique, Trust, and Responsiveness in the Classroom', 'Stephen D. Brookfield', 'Elementary Education', 'BEED / Teaching Practice'),
    ('Developmentally Appropriate Practice in Early Childhood Programs', 'National Association for the Education of Young Children', 'Early Childhood Education', 'BECED / Early Childhood Development'),
    ('The Whole-Brain Child', 'Daniel J. Siegel, Tina Payne Bryson', 'Early Childhood Education', 'BECED / Child Development'),
    ('Introduction to Hospitality', 'John R. Walker, Josielyn T. Walker', 'Hospitality Management', 'BSHM / Hospitality Management'),
    ('On Cooking: A Textbook of Culinary Fundamentals', 'Sarah R. Labensky, Alan M. Hause, Priscilla A. Martel', 'Hospitality Management', 'BSHM / Culinary Fundamentals')
)
insert into public.books (title, author, category, course_subject, description)
select
  sample.title,
  sample.author,
  sample.category,
  sample.course_subject,
  'SAMPLE RECORD - Illustrative reference for ' || sample.course_subject ||
    '. Not verified as an IBACMI Library holding; ask staff before treating it as available.'
from sample_books as sample
where not exists (
  select 1
  from public.books as existing
  where lower(existing.title) = lower(sample.title)
    and lower(existing.author) = lower(sample.author)
);
