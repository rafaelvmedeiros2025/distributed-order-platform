import { createPool } from '../src/db.js';
const pool = createPool();
try {
  await pool.query(`INSERT INTO products(sku,name,price_cents,stock) VALUES
    ('keyboard','Mechanical Keyboard',9900,25), ('mouse','Wireless Mouse',4500,50)
    ON CONFLICT (sku) DO NOTHING`);
  console.log('Demo catalog seeded');
} finally { await pool.end(); }
