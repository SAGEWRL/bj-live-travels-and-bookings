export function createD1Database(binding) {
  return {
    prepare(sql) {
      return {
        async get(...parameters) {
          return binding.prepare(sql).bind(...parameters).first();
        },
        async all(...parameters) {
          const result = await binding.prepare(sql).bind(...parameters).all();
          return result.results;
        },
        async run(...parameters) {
          const result = await binding.prepare(sql).bind(...parameters).run();
          return { changes: result.meta.changes };
        },
      };
    },
    async exec(sql) {
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await binding.prepare(statement).run();
      }
    },
  };
}