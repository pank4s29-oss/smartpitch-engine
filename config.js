// Public Supabase identifiers are safe to expose only with the RLS policies in supabase/schema.sql applied.
module.exports = (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  });
};
