process.env.PAYMENT_MODE='LOCAL_TEST';
process.env.HOST='127.0.0.1';
process.env.PORT=process.env.PORT||'3000';
process.env.PUBLIC_URL=`http://localhost:${process.env.PORT}`;
await import('../server/index.ts');
