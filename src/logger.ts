const fmt = (level: string, msg: string, data?: unknown) =>
	JSON.stringify({
		level,
		msg,
		...(data !== undefined ? { data } : {}),
		ts: new Date().toISOString(),
	});

export const logger = {
	info: (msg: string, data?: unknown) => console.log(fmt("info", msg, data)),
	error: (msg: string, data?: unknown) => console.error(fmt("error", msg, data)),
	warn: (msg: string, data?: unknown) => console.warn(fmt("warn", msg, data)),
};
