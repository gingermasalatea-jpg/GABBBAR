/**
 * Demo data so the whole app is usable before WhatsApp is connected.
 * Safe to re-run: it only inserts rows that are missing.
 * All demo contacts use +91 90000 000xx numbers and are flagged is_demo.
 */
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
import { migrate } from './migrate.js';
import { config } from '../config.js';

const DEMO_PASSWORD = 'Demo@12345';

const users = [
  { name: 'Super Admin', email: config.seed.adminEmail, role: 'super_admin', password: config.seed.adminPassword },
  { name: 'Asha Admin', email: 'admin@demo.local', role: 'admin', password: DEMO_PASSWORD },
  { name: 'Ravi Agent', email: 'ravi@demo.local', role: 'agent', password: DEMO_PASSWORD },
  { name: 'Neha Agent', email: 'neha@demo.local', role: 'agent', password: DEMO_PASSWORD },
  { name: 'Vikram Viewer', email: 'viewer@demo.local', role: 'viewer', password: DEMO_PASSWORD },
];

const customFields = [
  { key: 'city', label: 'City', type: 'text', internal: false },
  { key: 'order_id', label: 'Order ID', type: 'text', internal: false },
  { key: 'order_status', label: 'Order Status', type: 'select', options: ['Placed', 'Packed', 'Shipped', 'Delivered', 'Cancelled'], internal: false },
  { key: 'customer_type', label: 'Customer Type', type: 'select', options: ['Retail', 'Wholesale', 'Corporate'], internal: false },
  { key: 'pan_number', label: 'PAN Number', type: 'text', internal: true },
  { key: 'payment_proof', label: 'Payment Proof Link', type: 'text', internal: true },
  { key: 'credit_limit', label: 'Credit Limit (₹)', type: 'number', internal: true },
];

const people = [
  ['Rahul Sharma', 'Lucknow', 'Retail', 'Shipped', ['customer', 'lucknow']],
  ['Priya Patel', 'Ahmedabad', 'Wholesale', 'Placed', ['wholesale', 'vip']],
  ['Amit Verma', 'Delhi', 'Retail', 'Delivered', ['customer']],
  ['Sneha Iyer', 'Chennai', 'Corporate', 'Packed', ['corporate', 'vip']],
  ['Mohammed Arif', 'Hyderabad', 'Retail', 'Delivered', ['customer']],
  ['Kavita Joshi', 'Pune', 'Wholesale', 'Shipped', ['wholesale']],
  ['Suresh Yadav', 'Patna', 'Retail', 'Placed', ['lead']],
  ['Anjali Singh', 'Jaipur', 'Retail', 'Delivered', ['customer', 'repeat']],
  ['Deepak Gupta', 'Kanpur', 'Corporate', 'Placed', ['corporate', 'lead']],
  ['Pooja Mehta', 'Mumbai', 'Retail', 'Cancelled', ['customer']],
  ['Harpreet Kaur', 'Ludhiana', 'Wholesale', 'Shipped', ['wholesale', 'repeat']],
  ['Arjun Nair', 'Kochi', 'Retail', 'Delivered', ['customer']],
];

const knowledge = [
  ['business_info', 'About us', 'Sunrise Traders (demo business) manufactures and sells travel bags, backpacks, school bags and cloth bags. We supply retail customers, wholesalers and corporate/government buyers across India from our factory in Lucknow.'],
  ['business_info', 'Working hours', 'Our team is available Monday to Friday 9:30 AM to 6:30 PM and Saturday 10 AM to 2 PM (IST). We are closed on Sundays and national holidays.'],
  ['faq', 'How long does delivery take?', 'Orders are usually dispatched within 2 working days. Delivery normally takes 3–7 working days depending on the city. Exact dates depend on the courier and cannot be guaranteed.'],
  ['faq', 'How can I track my order?', 'Once your order is shipped we send the courier name and tracking number on WhatsApp. You can also share your order ID here and our team will check the status.'],
  ['faq', 'What payment methods do you accept?', 'We accept UPI, bank transfer (NEFT/RTGS/IMPS) and major debit/credit cards through our payment link. Cash on delivery is available for retail orders below ₹5,000.'],
  ['faq', 'What is your return policy?', 'Unused products in original packaging can be returned within 7 days of delivery for manufacturing defects. Please share photos of the product and your order ID; our team reviews each request.'],
  ['faq', 'Do you take bulk or corporate orders?', 'Yes. We take bulk orders for school bags, tool kit bags, cloth bags and promotional bags with custom printing. Minimum order quantity for custom printing is 100 pieces. Share quantity, design and delivery city for a quote.'],
  ['faq', 'Do you offer custom logo printing?', 'Yes, we offer screen printing and embroidery of logos on most bags. Printing charges depend on the number of colours and quantity. Our team will share a quote after seeing the artwork.'],
  ['faq', 'Where is your shop located?', 'Our factory and office are in Lucknow, Uttar Pradesh. Visits are by appointment — please message us to book a time.'],
  ['document', 'Product range', 'Travel bags (cabin and check-in sizes), laptop backpacks, school bags (sizes for classes 1–12), tool kit bags for industrial use, cotton and jute cloth bags, and promotional bags. Colours and sizes vary by stock.'],
];

const templates = [
  {
    name: 'order_update',
    category: 'UTILITY',
    status: 'APPROVED',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is now {{3}}. Reply to this message if you have any questions.', example: { body_text: [['Rahul', 'SUN1023', 'Shipped']] } },
      { type: 'FOOTER', text: 'Sunrise Traders' },
    ],
  },
  {
    name: 'festive_offer',
    category: 'MARKETING',
    status: 'APPROVED',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Festive collection is here 🎉' },
      { type: 'BODY', text: 'Hi {{1}}, our new festive range of travel bags and backpacks is now available. Reply YES to see the catalogue.', example: { body_text: [['Priya']] } },
      { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'YES' }, { type: 'QUICK_REPLY', text: 'Not now' }] },
    ],
  },
  {
    name: 'payment_reminder',
    category: 'UTILITY',
    status: 'REJECTED',
    rejection_reason: 'INVALID_FORMAT — variable at the start of the message body',
    components: [{ type: 'BODY', text: '{{1}} your payment of ₹{{2}} is pending.' }],
  },
];

async function main() {
  await migrate({ log: () => {} });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const userIds = {};
    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 10);
      const { rows } = await c.query(
        `INSERT INTO users (name, email, role, password_hash) VALUES ($1, lower($2), $3, $4)
         ON CONFLICT (lower(email)) DO UPDATE SET name = users.name RETURNING id`,
        [u.name, u.email, u.role, hash],
      );
      userIds[u.email] = rows[0].id;
    }

    for (const f of customFields) {
      await c.query(
        `INSERT INTO custom_fields (key, label, type, options, internal) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
        [f.key, f.label, f.type, JSON.stringify(f.options || []), f.internal],
      );
    }

    const labelIds = {};
    for (const [name, color] of [['New lead', '#3b82f6'], ['Order issue', '#ef4444'], ['Bulk enquiry', '#a855f7'], ['Payment', '#f59e0b'], ['VIP', '#22c55e']]) {
      const { rows } = await c.query(
        `INSERT INTO labels (name, color) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET color = labels.color RETURNING id`,
        [name, color],
      );
      labelIds[name] = rows[0].id;
    }

    for (const [type, title, content] of knowledge) {
      const { rows } = await c.query('SELECT 1 FROM knowledge_items WHERE title = $1', [title]);
      if (!rows.length) await c.query('INSERT INTO knowledge_items (type, title, content) VALUES ($1,$2,$3)', [type, title, content]);
    }

    for (const t of templates) {
      await c.query(
        `INSERT INTO templates (name, language, category, status, components, rejection_reason, wa_template_id, last_synced_at)
         VALUES ($1,'en',$2,$3,$4,$5,$6, now()) ON CONFLICT (name, language) DO NOTHING`,
        [t.name, t.category, t.status, JSON.stringify(t.components), t.rejection_reason || null, `demo_${t.name}`],
      );
    }

    const agentIds = [userIds['ravi@demo.local'], userIds['neha@demo.local']];
    const now = Date.now();
    const scripts = [
      [['in', 'Hi, mera order kab tak aayega? Order id SUN1001'], ['out', 'ai', 'Namaste Rahul ji! Aapka order SUN1001 ship ho chuka hai. Delivery usually 3–7 working days mein hoti hai. Tracking number humne WhatsApp par bheja hai.']],
      [['in', 'Need 500 school bags with our school logo. Can you share price?'], ['out', 'agent', 'Hi Priya, thanks for the enquiry! Could you share the bag size, number of print colours and delivery city? We will send a quote today.'], ['in', 'Size for class 6-8, 2 colour logo, Ahmedabad']],
      [['in', 'Do you accept UPI?'], ['out', 'ai', 'Yes Amit, we accept UPI, bank transfer and cards through our payment link. 😊']],
      [['in', 'Hello, the zip on my bag broke within 2 days.'], ['out', 'agent', 'Sorry to hear that, Sneha. Please share a photo of the bag and your order ID and we will arrange a replacement review.']],
      [['in', 'Can I visit your factory tomorrow?']],
      [['in', 'Price for 100 jute bags?']],
      [['in', 'Do you deliver to Patna?'], ['out', 'ai', 'Yes Suresh ji, we deliver across India including Patna. Delivery usually takes 3–7 working days.']],
      [['in', 'Thanks, received my order!'], ['out', 'agent', 'Wonderful, Anjali! Thank you for shopping with us. 🙏']],
    ];

    for (const [i, [name, city, type, status, tags]] of people.entries()) {
      const phone = `+9190000000${String(i + 1).padStart(2, '0')}`;
      const optedIn = i % 4 !== 3;
      const { rows } = await c.query(
        `INSERT INTO contacts (phone, name, tags, custom, opted_in, opt_in_source, opt_in_at, source, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'seed',true)
         ON CONFLICT (phone) DO UPDATE SET name = contacts.name RETURNING id, (xmax = 0) AS inserted`,
        [
          phone,
          name,
          tags,
          { city, customer_type: type, order_status: status, order_id: `SUN${1001 + i}`, pan_number: `ABCDE${1000 + i}F`, credit_limit: 50000 },
          optedIn,
          optedIn ? 'website_form' : null,
          optedIn ? new Date(now - 30 * 864e5) : null,
        ],
      );
      if (!rows[0].inserted || !scripts[i]) continue;
      const contactId = rows[0].id;
      const script = scripts[i];
      const lastIn = [...script].reverse().find((m) => m[0] === 'in');
      const baseTime = now - (i + 1) * 47 * 60_000;
      const resolved = i === 7;
      const { rows: conv } = await c.query(
        `INSERT INTO conversations (contact_id, status, assigned_to, unread_count, last_handler, resolved_at, resolved_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [contactId, resolved ? 'resolved' : 'open', i % 3 === 2 ? null : agentIds[i % 2], script[script.length - 1][0] === 'in' ? 1 : 0,
          script.find((m) => m[1] === 'ai') ? 'ai' : script.find((m) => m[1] === 'agent') ? 'human' : null, resolved ? new Date(baseTime + 10 * 60_000) : null,
          resolved ? agentIds[i % 2] : null, new Date(baseTime)],
      );
      let t = baseTime;
      for (const [idx, m] of script.entries()) {
        t += (idx + 1) * 2 * 60_000;
        const isIn = m[0] === 'in';
        await c.query(
          `INSERT INTO messages (conversation_id, contact_id, direction, sender_type, sender_user_id, type, body, status, wa_message_id, created_at, sent_at, delivered_at, read_at)
           VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,$10,$10,$11)`,
          [
            conv[0].id,
            contactId,
            isIn ? 'in' : 'out',
            isIn ? 'contact' : m[1],
            !isIn && m[1] === 'agent' ? agentIds[i % 2] : null,
            isIn ? m[1] : m[2],
            isIn ? 'received' : 'read',
            `demo.${contactId}.${idx}`,
            new Date(t),
            isIn ? null : new Date(t + 1000),
            isIn ? null : new Date(t + 60_000),
          ],
        );
        if (m === lastIn) await c.query('UPDATE contacts SET last_inbound_at = $2 WHERE id = $1', [contactId, new Date(t)]);
      }
      const last = script[script.length - 1];
      await c.query(
        `UPDATE conversations SET last_message_at = $2, last_message_preview = $3,
           last_inbound_at = (SELECT last_inbound_at FROM contacts WHERE id = $4) WHERE id = $1`,
        [conv[0].id, new Date(t), (last[0] === 'in' ? last[1] : last[2]).slice(0, 120), contactId],
      );
      if (i === 1) await c.query('INSERT INTO conversation_labels VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING', [conv[0].id, labelIds['Bulk enquiry'], labelIds.VIP]);
      if (i === 3) {
        await c.query('INSERT INTO conversation_labels VALUES ($1,$2) ON CONFLICT DO NOTHING', [conv[0].id, labelIds['Order issue']]);
        await c.query('INSERT INTO notes (conversation_id, user_id, body) VALUES ($1,$2,$3)', [conv[0].id, agentIds[1], 'Customer is a corporate buyer — escalate replacement to Asha if photo confirms defect.']);
        await c.query(
          `INSERT INTO tickets (conversation_id, contact_id, subject, description, source, priority) VALUES ($1,$2,$3,$4,'manual','high')`,
          [conv[0].id, contactId, 'Broken zip — replacement review', 'Customer reports zip broke within 2 days of delivery.'],
        );
      }
      if (i === 4) {
        await c.query(
          `INSERT INTO tickets (conversation_id, contact_id, subject, description, source) VALUES ($1,$2,$3,$4,'ai_fallback')`,
          [conv[0].id, contactId, 'AI could not answer: factory visit request', 'Customer asked: "Can I visit your factory tomorrow?" — no confirmed visiting slots in knowledge base.'],
        );
        await c.query(
          `INSERT INTO ai_logs (conversation_id, mode, provider, model, input, output, decision, guardrail_flags, latency_ms)
           VALUES ($1,'auto','mock','mock-retrieval',$2,$3,'fallback',$4,12)`,
          [conv[0].id, { customer_message: 'Can I visit your factory tomorrow?' }, 'Thanks for your question! Let me check this with our team — someone will get back to you shortly.', ['low_relevance']],
        );
      }
    }

    const { rows: existingAuto } = await c.query('SELECT count(*)::int AS n FROM automations');
    if (!existingAuto[0].n) {
      await c.query(
        `INSERT INTO automations (name, type, is_active, priority, trigger, response) VALUES
         ('Welcome new customers', 'welcome', true, 10, '{}', $1),
         ('Out of hours reply', 'out_of_hours', true, 20, '{}', '{}'),
         ('Catalogue keyword', 'keyword', true, 30, $2, $3)`,
        [
          { text: 'Hi {{first_name}}! 👋 Welcome to Sunrise Traders. How can we help you today?' },
          { keywords: ['catalogue', 'catalog', 'price list'], match: 'contains' },
          { text: 'Here is our latest catalogue: https://example.com/catalogue.pdf — tell us the product and quantity and we will share a quote.' },
        ],
      );
      const { rows: flow } = await c.query(
        `INSERT INTO automations (name, type, is_active, priority, trigger, flow_start_node)
         VALUES ('Order help menu', 'flow', true, 40, $1, 'start') RETURNING id`,
        [{ keywords: ['menu', 'help'], match: 'exact' }],
      );
      const nodes = [
        ['start', 'buttons', { text: 'Hi {{first_name}}, what do you need help with?', buttons: [{ id: 'track', title: 'Track order' }, { id: 'bulk', title: 'Bulk order' }, { id: 'agent', title: 'Talk to team' }] }, { track: 'track', bulk: 'bulk', agent: 'handoff_human', default: 'handoff_ai' }, 0],
        ['track', 'condition', { field: 'custom.order_status', operator: 'exists' }, { true: 'status_msg', false: 'ask_id' }, 1],
        ['status_msg', 'message', { text: 'Your latest order {{custom.order_id}} is currently: {{custom.order_status}}.' }, {}, 2],
        ['ask_id', 'message', { text: 'Please share your order ID and our team will check it for you.' }, { default: 'handoff_human' }, 3],
        ['bulk', 'tag', { add: ['bulk-enquiry'] }, { default: 'bulk_msg' }, 4],
        ['bulk_msg', 'message', { text: 'Great! Please share the product, quantity, logo/artwork and delivery city.' }, { default: 'assign_bulk' }, 5],
        ['assign_bulk', 'assign', { strategy: 'round_robin' }, {}, 6],
        ['handoff_human', 'handoff', { to: 'human', message: 'Connecting you with our team — someone will reply shortly.' }, {}, 7],
        ['handoff_ai', 'handoff', { to: 'ai' }, {}, 8],
      ];
      for (const [key, type, cfg, next, pos] of nodes) {
        await c.query('INSERT INTO flow_nodes (automation_id, node_key, type, config, next, position) VALUES ($1,$2,$3,$4,$5,$6)', [flow[0].id, key, type, cfg, next, pos]);
      }
    }

    await c.query(
      `INSERT INTO settings (key, value) VALUES ('business', $1) ON CONFLICT (key) DO NOTHING`,
      [{ name: 'Sunrise Traders (Demo)', about: 'Bags for travel, school and business', email: 'hello@example.com', website: 'https://example.com', address: 'Lucknow, Uttar Pradesh', timezone: 'Asia/Kolkata' }],
    );

    await c.query('COMMIT');
    console.log('Seed complete.');
    console.log(`  Super Admin: ${config.seed.adminEmail} / ${config.seed.adminPassword}`);
    console.log(`  Admin: admin@demo.local / ${DEMO_PASSWORD}`);
    console.log(`  Agents: ravi@demo.local, neha@demo.local / ${DEMO_PASSWORD}`);
    console.log(`  Viewer: viewer@demo.local / ${DEMO_PASSWORD}`);
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
