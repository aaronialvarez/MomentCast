export async function onRequest(context) {
  const url = new URL(context.request.url);
  
  // If requesting a file that exists, serve it
  if (url.pathname.match(/\.(html|js|css|png|jpg|jpeg|gif|svg|ico)$/)) {
    return context.next();
  }
  
  // Otherwise, serve index.html for SPA routing
  return context.env.ASSETS.fetch(new URL('/index.html', url.origin));
}