import { registerPlugin, WebPlugin } from '@capacitor/core';
const ERR = 'NativeAgent is only available on native platforms.';
class NativeAgentWeb extends WebPlugin {
    async checkAvailability() {
        // Web target: there is no native library, but the probe contract is
        // "resolve, never reject" so UI code can branch on `available`.
        return { abi: 'web', is64Bit: false, available: false, reason: ERR, engineGeneration: 'web' };
    }
    async initWorkspace() { throw this.unavailable(ERR); }
    async initialize() { throw this.unavailable(ERR); }
    async sendMessage() { throw this.unavailable(ERR); }
    async followUp() { throw this.unavailable(ERR); }
    async abort() { throw this.unavailable(ERR); }
    async steer() { throw this.unavailable(ERR); }
    async respondToApproval() { throw this.unavailable(ERR); }
    async respondToMcpTool() { throw this.unavailable(ERR); }
    async getAuthToken() { throw this.unavailable(ERR); }
    async setAuthKey() { throw this.unavailable(ERR); }
    async deleteAuth() { throw this.unavailable(ERR); }
    async refreshToken() { throw this.unavailable(ERR); }
    async getAuthStatus() { throw this.unavailable(ERR); }
    async exchangeOAuthCode() { throw this.unavailable(ERR); }
    async listSessions() { throw this.unavailable(ERR); }
    async loadSession() { throw this.unavailable(ERR); }
    async resumeSession() { throw this.unavailable(ERR); }
    async clearSession() { throw this.unavailable(ERR); }
    async addCronJob() { throw this.unavailable(ERR); }
    async updateCronJob() { throw this.unavailable(ERR); }
    async removeCronJob() { throw this.unavailable(ERR); }
    async listCronJobs() { throw this.unavailable(ERR); }
    async runCronJob() { throw this.unavailable(ERR); }
    async listCronRuns() { throw this.unavailable(ERR); }
    async handleWake() { throw this.unavailable(ERR); }
    async getSchedulerConfig() { throw this.unavailable(ERR); }
    async setSchedulerConfig() { throw this.unavailable(ERR); }
    async setHeartbeatConfig() { throw this.unavailable(ERR); }
    async scheduleBackgroundWakes() { throw this.unavailable(ERR); }
    async cancelBackgroundWakes() { throw this.unavailable(ERR); }
    async getWakeStatus() { throw this.unavailable(ERR); }
    async loadSurfacedMessages() { throw this.unavailable(ERR); }
    async clearSurfacedMessages() { throw this.unavailable(ERR); }
    async respondToCronApproval() { throw this.unavailable(ERR); }
    async addSkill() { throw this.unavailable(ERR); }
    async updateSkill() { throw this.unavailable(ERR); }
    async removeSkill() { throw this.unavailable(ERR); }
    async listSkills() { throw this.unavailable(ERR); }
    async startSkill() { throw this.unavailable(ERR); }
    async endSkill() { throw this.unavailable(ERR); }
    async startMcp() { throw this.unavailable(ERR); }
    async restartMcp() { throw this.unavailable(ERR); }
    async getModels() { throw this.unavailable(ERR); }
    async invokeTool() { throw this.unavailable(ERR); }
    async seedToolPermissions() { throw this.unavailable(ERR); }
    async setToolPermission() { throw this.unavailable(ERR); }
    async listToolPermissions() { throw this.unavailable(ERR); }
    async resetToolPermissions() { throw this.unavailable(ERR); }
}
export const NativeAgent = registerPlugin('NativeAgent', {
    web: () => Promise.resolve(new NativeAgentWeb()),
});
//# sourceMappingURL=plugin.js.map