/// <reference lib="dom" />
import { webkit, BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

export interface WAInstance {
    context: BrowserContext;
    page: Page;
    id: string;
    status: 'disconnected' | 'connecting' | 'connected' | 'qr';
    qrCode?: string;
    qrCodeBase64?: string;
}

export type WAEvent =
    | 'qr'
    | 'ready'
    | 'authenticated'
    | 'auth_failure'
    | 'disconnected'
    | 'message'
    | 'message_create'
    | 'message_ack'
    | 'message_revoke_everyone'
    | 'group_join'
    | 'group_leave'
    | 'group_update'
    | 'call';

export class WhatsAppManager extends EventEmitter {
    private instances: Map<string, WAInstance> = new Map();

    constructor() {
        super();
        this.ensureSessionDir();
    }

    private ensureSessionDir() {
        if (!fs.existsSync(env.waSessionPath)) {
            fs.mkdirSync(env.waSessionPath, { recursive: true });
        }
    }

    async createInstance(instanceId: string): Promise<WAInstance> {
        if (this.instances.has(instanceId)) {
            throw new Error(`Instance ${instanceId} already exists`);
        }

        const sessionPath = path.join(env.waSessionPath, instanceId);

        logger.info({ instanceId, engine: 'WebKit' }, 'Launching Safari/WebKit instance...');

        // Launch Persistent Context (Saves session data)
        const context = await webkit.launchPersistentContext(sessionPath, {
            headless: true, // Set to false to see the browser
            viewport: { width: 1280, height: 960 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
            permissions: ['clipboard-read', 'clipboard-write'],
            bypassCSP: true, // Important for injecting scripts
        });

        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        const instance: WAInstance = {
            context,
            page,
            id: instanceId,
            status: 'disconnected',
        };

        this.instances.set(instanceId, instance);

        // Handle Disconnect
        context.on('close', () => {
            this.updateInstanceStatus(instanceId, 'DISCONNECTED');
            instance.status = 'disconnected';
            this.emit('disconnected', { instanceId });
        });

        return instance;
    }

    async connect(instanceId: string): Promise<WAInstance> {
        let instance = this.instances.get(instanceId);
        if (!instance) instance = await this.createInstance(instanceId);

        if (instance.status === 'connected' || instance.status === 'connecting') return instance;

        instance.status = 'connecting';
        this.emit('status_change', { instanceId, status: 'connecting' });

        // Run async without awaiting to not block server
        this.initializePage(instance).catch(err => {
            logger.error({ instanceId, err }, 'Failed to initialize page');
            instance!.status = 'disconnected';
        });

        return instance;
    }

    private async initializePage(instance: WAInstance) {
        const { page, id } = instance;

        try {
            logger.info({ id }, 'Navigating to WhatsApp Web...');
            await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

            // Inject WPPConnect/WA-JS
            await page.addScriptTag({ url: 'https://github.com/wppconnect-team/wa-js/releases/download/nightly/wppconnect-wa.js' });

            // Wait for load
            await page.waitForTimeout(5000);

            // Check for potential QR Code or Ready state loop
            this.monitorState(instance);

        } catch (error) {
            logger.error({ id, error }, 'Error during page initialization');
        }
    }

    private async monitorState(instance: WAInstance) {
        const { page, id } = instance;

        let attempts = 0;
        const checkInterval = setInterval(async () => {
            if (attempts > 60) { // 1 minute timeout
                clearInterval(checkInterval);
                return;
            }
            attempts++;

            try {
                // Check if connected (Main page element present)
                const isConnected = await page.$('#pane-side');
                if (isConnected) {
                    if (instance.status !== 'connected') {
                        logger.info({ id }, 'WhatsApp Connected!');
                        instance.status = 'connected';
                        instance.qrCode = undefined;
                        instance.qrCodeBase64 = undefined;
                        this.updateInstanceStatus(id, 'CONNECTED');
                        this.emit('ready', { instanceId: id });
                        this.emit('authenticated', { instanceId: id });
                        clearInterval(checkInterval);
                    }
                    return;
                }

                // Check for QR Code
                const qrCanvas = await page.$('canvas');
                if (qrCanvas) {
                    // Extract QR Data
                    const qrData = await page.evaluate(() => {
                        const selector = document.querySelector('canvas');
                        // @ts-ignore
                        return selector ? selector.closest('[data-ref]').getAttribute('data-ref') : null;
                    });

                    // Generate Base64 for display
                    const qrBase64 = await page.evaluate(() => {
                        const canvas = document.querySelector('canvas');
                        return canvas ? canvas.toDataURL() : null;
                    });

                    if (qrData && qrBase64 && instance.qrCode !== qrData) {
                        instance.status = 'qr';
                        instance.qrCode = qrData;
                        instance.qrCodeBase64 = qrBase64;
                        logger.info({ id }, 'QR Code generated');
                        this.emit('qr', { instanceId: id, qr: qrData, qrBase64 });
                    }
                }

            } catch (err) {
                // ignore transient errors
            }
        }, 1000);
    }

    async getStatus(instanceId: string) {
        const instance = this.instances.get(instanceId);
        if (!instance) return 'not_found';
        return instance.status;
    }

    getQRCode(instanceId: string) {
        const instance = this.instances.get(instanceId);
        return { qr: instance?.qrCode, qrBase64: instance?.qrCodeBase64 };
    }

    // Helper to update DB status
    private async updateInstanceStatus(id: string, status: string) {
        await prisma.instance.update({
            where: { id },
            data: { status }
        });
    }

    // Stub for reconnectAll (can be implemented similarly to before)
    async reconnectAll() {
        const instances = await prisma.instance.findMany({ where: { status: 'CONNECTED' } });
        for (const inst of instances) {
            this.connect(inst.id); // fire and forget
        }
    }

    // ==========================================
    // Messaging Methods (Using WPPConnect injection)
    // ==========================================

    async sendMessage(instanceId: string, to: string, content: string) {
        const instance = this.instances.get(instanceId);
        if (!instance || instance.status !== 'connected') throw new Error('Instance not connected');

        // Format number (simple version)
        const chatId = to.includes('@') ? to : `${to}@c.us`;

        return await instance.page.evaluate(({ chatId, content }) => {
            // @ts-ignore
            return window.WPP.chat.sendText(chatId, content);
        }, { chatId, content });
    }

    // ==========================================
    // Stubs for Compatibility (To be implemented)
    // ==========================================

    async getContacts(instanceId: string) { return []; }
    async getContactById(instanceId: string, contactId: string) { return null; }
    async isRegisteredUser(instanceId: string, number: string) { return true; }
    async blockContact(instanceId: string, contactId: string) { }
    async unblockContact(instanceId: string, contactId: string) { }
    async getBlockedContacts(instanceId: string) { return []; }
    async getProfilePicUrl(instanceId: string, contactId: string) { return ''; }

    async getChats(instanceId: string) { return []; }
    async getChatById(instanceId: string, chatId: string) { return null; }
    async getMessages(instanceId: string, chatId: string, limit = 50) { return []; }
    async clearChat(instanceId: string, chatId: string) { }
    async deleteChat(instanceId: string, chatId: string) { }
    async archiveChat(instanceId: string, chatId: string) { }
    async unarchiveChat(instanceId: string, chatId: string) { }
    async pinChat(instanceId: string, chatId: string) { }
    async unpinChat(instanceId: string, chatId: string) { }
    async muteChat(instanceId: string, chatId: string, duration?: any) { }
    async unmuteChat(instanceId: string, chatId: string) { }
    async markChatUnread(instanceId: string, chatId: string) { }
    async resolveChatId(instance: any, number: string) { return number.includes('@') ? number : number + '@c.us'; }

    async createGroup(instanceId: string, name: string, participants: string[]) { return {}; }
    async getGroupInfo(instanceId: string, groupId: string) { return {}; }
    async addParticipants(instanceId: string, groupId: string, participants: string[]) { }
    async removeParticipants(instanceId: string, groupId: string, participants: string[]) { }
    async promoteParticipants(instanceId: string, groupId: string, participants: string[]) { }
    async demoteParticipants(instanceId: string, groupId: string, participants: string[]) { }
    async setGroupSubject(instanceId: string, groupId: string, subject: string) { }
    async setGroupDescription(instanceId: string, groupId: string, description: string) { }
    async leaveGroup(instanceId: string, groupId: string) { }
    async getInviteCode(instanceId: string, groupId: string) { return ''; }
    async revokeInviteCode(instanceId: string, groupId: string) { return ''; }
    async joinGroupByInviteCode(instanceId: string, inviteCode: string) { return ''; }

    async sendMedia(instanceId: string, to: string, mediaUrl: string, options?: any) { }
    async sendMediaBase64(instanceId: string, to: string, base64: string, mimetype: string, options?: any) { }
    async sendLocation(instanceId: string, to: string, latitude: number, longitude: number, description?: string) { }
    async sendContact(instanceId: string, to: string, contactId: string) { }
    async sendPoll(instanceId: string, to: string, title: string, options: string[], pollOptions?: any) { }
    async sendPresence(instanceId: string, to: string, presence: any) { }
    async editMessage(instanceId: string, messageId: string, newText: string) { }
    async reactToMessage(instanceId: string, messageId: string, reaction: string) { }
    async deleteMessage(instanceId: string, messageId: string, forEveryone: boolean = true) { }
    async downloadMedia(instanceId: string, messageId: string) { return null; }

    async sendText(instanceId: string, to: string, content: string) {
        return this.sendMessage(instanceId, to, content);
    }

    // Aliases for compatibility
    async getChatMessages(instanceId: string, chatId: string, limit = 50) { return this.getMessages(instanceId, chatId, limit); }
    async markChatAsRead(instanceId: string, chatId: string) { return this.markChatUnread(instanceId, chatId); } // TODO: Implement read vs unread correctly

    // Profile
    async setProfileName(instanceId: string, name: string) { }
    async setMyStatus(instanceId: string, status: string) { } // Changed name to avoid conflict with getStatus/setStatus logic if any
    async setProfilePicture(instanceId: string, url: string) { }

    // Labels
    async getLabels(instanceId: string) { return []; }
    async addLabelToChat(instanceId: string, chatId: string, labelId: string) { }
    async removeLabelFromChat(instanceId: string, chatId: string, labelId: string) { }

    async updateInstanceSettings(id: string, settings: any) {
        // ... logic to update settings
    }
    async getSettings(instanceId: string) { return this.instanceSettings.get(instanceId) || {}; }

    formatNumber(number: string): string {
        return number.replace(/\D/g, '');
    }

    async disconnect(instanceId: string) { await this.logout(instanceId); }

    private instanceSettings: Map<string, any> = new Map();
    public alwaysOnlineIntervals: Map<string, NodeJS.Timeout> = new Map();

    async logout(instanceId: string) {
        const instance = this.instances.get(instanceId);
        if (instance) {
            await instance.context.close().catch(() => { });
            this.instances.delete(instanceId);
        }
    }

    async deleteInstance(instanceId: string) {
        await this.logout(instanceId);
        // Additional cleanup if needed
    }

    getInstance(instanceId: string) { return this.instances.get(instanceId); }
    getClient(instanceId: string) { return this.instances.get(instanceId)?.page; }
    getAllInstances() { return Array.from(this.instances.keys()); }
}

export const waManager = new WhatsAppManager();
