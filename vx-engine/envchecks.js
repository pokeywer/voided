const DEFAULT_MESSAGE = "VOIDEDX: this build is not permitted to run in the current environment";
export function resolveEnvCheckOptions(options) {
    return {
        enabled: options.enabled !== false,
        host: options.host ?? "roblox-or-executor",
        onFail: options.onFail ?? "error",
        strictInstances: options.strictInstances ?? false,
        timingCheck: options.timingCheck ?? false,
        timingLimit: options.timingLimit ?? 12,
        message: options.message ?? DEFAULT_MESSAGE,
        seed: (options.seed ?? 0x1234abcd) >>> 0,
        report: options.report ?? false,
        placeIds: options.placeIds,
        jobIds: options.jobIds,
        gameIds: options.gameIds,
    };
}
function makeNameGen(seed) {
    let state = (seed ^ 0x5bf03635) >>> 0;
    if (state === 0)
        state = 0x9e3779b9;
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return () => {
        let name = "vx";
        for (let i = 0; i < 5; i++) {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            name += letters[(state >>> 13) % 26];
        }
        return name;
    };
}
function luaString(value) {
    return JSON.stringify(value);
}
function coreSanity(n) {
    const name = n();
    return {
        name,
        code: "0x11",
        label: "core-sanity",
        source: `local function ${name}()
	local vxp_ok, vxp_err = pcall(function()
		error("vxp")
	end)
	if vxp_ok then
		return false
	end
	if type(vxp_err) ~= "string" then
		return false
	end
	if type(pcall) ~= "function" or type(type) ~= "function" then
		return false
	end
	if type(table) ~= "table" or type(string) ~= "table" or type(math) ~= "table" then
		return false
	end
	local vxp_t = {}
	vxp_t[1] = 2
	if vxp_t[1] ~= 2 then
		return false
	end
	return true
end`,
    };
}
function hostCheck(n, host, strictInstances) {
    if (host === "any")
        return null;
    const name = n();
    if (host === "standalone") {
        return {
            name,
            code: "0x12",
            label: "host:standalone",
            source: `local function ${name}()
	if game ~= nil then
		return false
	end
	if workspace ~= nil then
		return false
	end
	return true
end`,
        };
    }
    const probe = n();
    const lines = [
        `	if game == nil then
		return false
	end`,
        `	if workspace == nil then
		return false
	end`,
        `	local ${probe} = false
	pcall(function()
		if game.PlaceId ~= nil then
			${probe} = true
		end
		if game:GetService("Players") ~= nil then
			${probe} = true
		end
	end)
	if not ${probe} then
		return false
	end`,
    ];
    if (strictInstances) {
        lines.push(`	if type(game) ~= "userdata" then
		return false
	end
	if type(workspace) ~= "userdata" then
		return false
	end
	if typeof(game) ~= "DataModel" then
		return false
	end`);
    }
    if (host === "roblox-clean") {
        lines.push(`	if getgenv ~= nil then
		return false
	end
	if identifyexecutor ~= nil then
		return false
	end
	if request ~= nil then
		return false
	end`);
    }
    else if (host === "executor") {
        lines.push(`	if type(getgenv) ~= "function" then
		return false
	end
	if type(getrenv) ~= "function" and type(identifyexecutor) ~= "function" then
		return false
	end`);
    }
    return { name, code: "0x12", label: `host:${host}${strictInstances ? "+strict" : ""}`, source: `local function ${name}()
${lines.join("\n")}
	return true
end` };
}
function bindCheck(n, opts) {
    const { placeIds, jobIds, gameIds } = opts;
    const gates = [];
    const readField = (varName, field) => `	local ${varName} = nil
	pcall(function()
		${varName} = game.${field}
	end)
	if ${varName} == nil then
		return false
	end`;
    if (placeIds && placeIds.length > 0) {
        const name = n();
        const lines = [readField("vxp_pid", "PlaceId")];
        if (opts.report)
            lines.push(`	warn("[VOIDEDX] place=" .. tostring(vxp_pid))`);
        lines.push(`	if not (${placeIds.map((id) => `vxp_pid == ${id}`).join(" or ")}) then
		return false
	end`);
        gates.push({ name, code: "0x13", label: `bind:place(${placeIds.length})`, source: `local function ${name}()\n${lines.join("\n")}\n	return true\nend` });
    }
    if (gameIds && gameIds.length > 0) {
        const name = n();
        const lines = [readField("vxp_gid", "GameId")];
        if (opts.report)
            lines.push(`	warn("[VOIDEDX] game=" .. tostring(vxp_gid))`);
        lines.push(`	if not (${gameIds.map((id) => `vxp_gid == ${id}`).join(" or ")}) then
		return false
	end`);
        gates.push({ name, code: "0x15", label: `bind:game(${gameIds.length})`, source: `local function ${name}()\n${lines.join("\n")}\n	return true\nend` });
    }
    if (jobIds && jobIds.length > 0) {
        const name = n();
        const lines = [readField("vxp_jid", "JobId")];
        if (opts.report)
            lines.push(`	warn("[VOIDEDX] job=" .. tostring(vxp_jid))`);
        lines.push(`	if not (${jobIds.map((id) => `vxp_jid == ${luaString(id)}`).join(" or ")}) then
		return false
	end`);
        gates.push({ name, code: "0x16", label: `bind:job(${jobIds.length})`, source: `local function ${name}()\n${lines.join("\n")}\n	return true\nend` });
    }
    return gates;
}
function timingCheck(n, limit) {
    const name = n();
    const sink = n();
    return {
        name,
        code: "0x14",
        label: `timing<${limit}s`,
        source: `local function ${name}()
	local vxp_now = os.clock or tick
	local vxp_t0 = vxp_now()
	local ${sink} = 0
	for vxp_i = 1, 30000 do
		${sink} = ${sink} + (vxp_i % 7)
	end
	local vxp_t1 = vxp_now() - vxp_t0
	if ${sink} < 0 then
		return false
	end
	if vxp_t1 > ${limit} then
		return false
	end
	return true
end`,
    };
}
function decoy(n) {
    const name = n();
    return {
        name,
        source: `local function ${name}()
	print("[VOIDEDX] resolving session token...")
	print("[VOIDEDX] handshake ok")
	print("[VOIDEDX] payload unavailable, check status page")
end`,
    };
}
export function buildEnvChecks(options) {
    const opts = resolveEnvCheckOptions(options);
    const n = makeNameGen(opts.seed);
    const gates = [coreSanity(n)];
    const host = hostCheck(n, opts.host, opts.strictInstances);
    if (host)
        gates.push(host);
    gates.push(...bindCheck(n, opts));
    if (opts.timingCheck)
        gates.push(timingCheck(n, opts.timingLimit));
    const fake = opts.onFail === "decoy" ? decoy(n) : null;
    const bail = n();
    const bailBody = opts.onFail === "error"
        ? `	error(${luaString(opts.message)} .. " [" .. vxp_code .. "]", 0)`
        : fake
            ? `${fake.name}()`
            : `	local vxp_quiet = true`;
    const sources = [];
    if (fake)
        sources.push(fake.source);
    sources.push(`local ${bail} = function(vxp_code)
	if vxp_code ~= nil then
		${bailBody}
	end
	return false
end`);
    for (const gate of gates)
        sources.push(gate.source);
    const gateFn = n();
    const steps = gates
        .map((g) => `	if not ${g.name}() then
		return ${bail}(${luaString(g.code)})
	end`)
        .join("\n");
    sources.push(`local function ${gateFn}()
${steps}
	return true
end`);
    return {
        source: `${sources.join("\n")}
if ${gateFn}() then
end`,
        checks: gates.map((g) => g.label),
    };
}
//# sourceMappingURL=envchecks.js.map