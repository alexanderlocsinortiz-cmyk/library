-- Backfill concise, title-specific descriptions for the existing catalog.
-- Preserve any descriptions a librarian may already have entered.
with catalog_descriptions(id, description) as (
  values
    ('2fff22e1-806f-419d-b93a-382c8c9f6229'::uuid, 'Introduces computer networks from the applications layer down through transport, network, link, and physical layers. Internet protocols and practical examples show how networked applications communicate.'),
    ('5482a6a9-4939-4512-8eb5-c3325495011e'::uuid, 'Surveys how criminal law and justice institutions respond to crime, introducing policing, courts, corrections, and the main processes of the criminal justice system.'),
    ('0f15bf7e-f6a5-4fe1-be0e-8ba0f28b3734'::uuid, 'A concise introduction to criminology that surveys theories and current research on crime, criminal behavior, and society’s responses. Real cases help connect criminological ideas to practice.'),
    ('5a3e5a36-6a25-4a10-ab7c-1d2403760be1'::uuid, 'Explains core database concepts, including data models, database design, query languages, transactions, storage, and implementation. Examples connect theory to systems used to organize and retrieve information.'),
    ('01fc6acd-a818-4582-aa38-4b06ba87a200'::uuid, 'A research-based guide to early learning from birth through age eight. It helps educators make intentional, equitable decisions by connecting child development, learning, families, and social and cultural context.'),
    ('7a3484ca-6afa-495a-96f7-df0971000400'::uuid, 'Connects research on learning, development, motivation, and assessment to decisions teachers make in the classroom. Cases and practical examples help readers apply educational psychology to teaching.'),
    ('5312eded-4c12-4613-89f0-e9d34461cc57'::uuid, 'Guides readers through deciding to start a venture, developing a business idea, launching a firm, and managing growth. Business examples introduce opportunities and common startup challenges.'),
    ('b38c769c-0ddd-42d9-9a1b-a6fba2faa01d'::uuid, 'Surveys the hospitality industry, including lodging, food and beverage, tourism, recreation, events, and related management. It introduces how these sectors operate and the issues shaping the field.'),
    ('55dd073a-980d-45b5-a53b-f16a2d836e33'::uuid, 'Teaches culinary fundamentals through techniques and principles, explaining how and why food preparation works. It covers ingredients, kitchen methods, safety, and core cooking practices.'),
    ('f00e9cda-e077-40da-8cb7-6f05b4ce347d'::uuid, 'Introduces public administration through management, political, and legal perspectives. It explores how public organizations operate and how government institutions, law, and public purposes shape administrative decisions.'),
    ('7026b394-9e68-45a9-9854-bef8a179acc9'::uuid, 'Explains public policy and how policy analysis compares possible solutions. It examines how issues are framed, how governments act, and how evidence and political arguments influence decisions.'),
    ('9955e5f9-f6cd-41df-acfd-b329d16efe74'::uuid, 'This appears to be a sample catalog entry rather than a verifiable published book. Library staff should confirm its title and author before adding a subject description.'),
    ('45947f04-3a99-49ce-b460-aeea3c91d499'::uuid, 'Presents an approach to developing businesses under uncertainty through rapid experiments, customer feedback, and iterative product development. It focuses on testing assumptions and learning which products and business models are viable.'),
    ('599b9910-82ff-407f-9308-9b776fea3226'::uuid, 'Offers practical guidance for teaching in diverse and unpredictable classrooms. It examines teaching choices, trust, student responsiveness, and ways instructors can reflect on and improve their practice.'),
    ('0ea0504d-f479-4da1-a72f-9cfa3f524579'::uuid, 'Explains children’s brain development and offers practical approaches to everyday behavior, emotions, and parent-child challenges. It connects brain development with strategies intended to support emotional and intellectual growth.')
)
update public.books as books
set description = descriptions.description
from catalog_descriptions as descriptions
where books.id = descriptions.id
  and nullif(btrim(books.description), '') is null;
