import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, generateWAMessageFromContent, prepareWAMessageMedia } from '@queenanya/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';

// Core State (Backwards-compatible globals)
let sock: any = null; // Refers to the "primary" socket for legacy compatibility
let qrBase64: string | null = null;
let activePairingCode: string | null = null;
let connectionStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
let lastError: string | null = null;

const connectionLogs: Array<{ id: string; timestamp: string; message: string; type: 'info' | 'error' | 'success' }> = [];
const sentMessages: Array<{ id: string; phoneNumber: string; message: string; timestamp: string; status: 'sent' | 'failed'; error?: string }> = [];

// Saved Groups interfaces & database
interface SavedGroup {
  jid: string;
  name: string;
  savedAt: string;
  sessionId?: string; // Storing which session captured or owns this group
}
const savedGroupsFilePath = path.join(process.cwd(), 'saved_groups.json');

function loadSavedGroups(): SavedGroup[] {
  try {
    if (fs.existsSync(savedGroupsFilePath)) {
      return JSON.parse(fs.readFileSync(savedGroupsFilePath, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading saved_groups.json:', err);
  }
  return [];
}

function saveGroupDetails(jid: string, name: string, sessionId?: string) {
  try {
    const groups = loadSavedGroups();
    const existingIndex = groups.findIndex(g => g.jid === jid);
    if (existingIndex > -1) {
      groups[existingIndex].name = name;
      groups[existingIndex].savedAt = new Date().toISOString();
      if (sessionId) {
        groups[existingIndex].sessionId = sessionId;
      }
    } else {
      groups.push({ 
        jid, 
        name, 
        savedAt: new Date().toISOString(), 
        sessionId: sessionId || 'primary' 
      });
    }
    fs.writeFileSync(savedGroupsFilePath, JSON.stringify(groups, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving group metadata:', err);
  }
}

function deleteSavedGroup(jid: string) {
  try {
    const groups = loadSavedGroups();
    const filtered = groups.filter(g => g.jid !== jid);
    fs.writeFileSync(savedGroupsFilePath, JSON.stringify(filtered, null, 2), 'utf8');
  } catch (err) {
    console.error('Error deleting saved group:', err);
  }
}

function getAssignedSessionIdForRecipient(recipient: string, recipientType: string, defaultSessionId: string, validSessions: string[]): string {
  if (recipientType === 'group' || recipient.endsWith('@g.us')) {
    let targetJid = recipient;
    if (!targetJid.includes('@')) {
      targetJid = `${targetJid}@g.us`;
    }
    const savedGroups = loadSavedGroups();
    const matchedGroup = savedGroups.find(g => g.jid === targetJid);
    if (matchedGroup && matchedGroup.sessionId) {
      if (validSessions.includes(matchedGroup.sessionId)) {
        return matchedGroup.sessionId;
      }
    }
  }
  return defaultSessionId;
}

// Multi-Session state interfaces & loaders
interface SessionData {
  id: string;
  name: string;
  sock: any | null;
  status: 'disconnected' | 'connecting' | 'connected';
  qrBase64: string | null;
  activePairingCode: string | null;
  user: { id: string; name: string } | null;
  lastError: string | null;
}

const sessions = new Map<string, SessionData>();
const sessionsConfigPath = path.join(process.cwd(), 'sessions.json');

function loadSessionsConfig(): Array<{ id: string; name: string }> {
  try {
    if (fs.existsSync(sessionsConfigPath)) {
      return JSON.parse(fs.readFileSync(sessionsConfigPath, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading sessions.json:', err);
  }
  const defaultSessions = [{ id: 'primary', name: 'Primary Account' }];
  try {
    fs.writeFileSync(sessionsConfigPath, JSON.stringify(defaultSessions, null, 2), 'utf8');
  } catch (err) {}
  return defaultSessions;
}

function saveSessionsConfig(config: Array<{ id: string; name: string }>) {
  try {
    fs.writeFileSync(sessionsConfigPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving sessions.json:', err);
  }
}

// Message Queue interfaces & state
interface QueueItem {
  id: string;
  recipient: string;
  recipientType: 'individual' | 'group';
  messageType: string;
  message: string;
  footer?: string;
  attachmentType?: 'none' | 'image' | 'video' | 'pdf' | 'doc';
  attachmentUrl?: string;
  attachmentData?: string;
  attachmentName?: string;
  inlineAttachment?: boolean;
  buttons?: any[];
  templateButtons?: any[];
  sessionId: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  addedAt: string;
  sentAt?: string;
  error?: string;
  workflowName?: string;
}

let messageQueue: QueueItem[] = [];
let isProcessingQueue = false;
let globalDelaySeconds = 2; // Default delay: 2 seconds

function pushToQueue(item: Omit<QueueItem, 'id' | 'status' | 'addedAt'>) {
  const newItem: QueueItem = {
    ...item,
    id: Math.random().toString(36).substring(7),
    status: 'pending',
    addedAt: new Date().toISOString()
  };
  messageQueue.push(newItem);
  addLog(`Queue: Added message for ${item.recipient} (Session: ${item.sessionId})`, 'info');
  processQueue();
  return newItem;
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (true) {
    const item = messageQueue.find(i => i.status === 'pending');
    if (!item) {
      break;
    }

    item.status = 'sending';
    addLog(`Queue: Processing item ${item.id} for ${item.recipient} (Session: ${item.sessionId})...`, 'info');

    const session = sessions.get(item.sessionId);
    if (!session || session.status !== 'connected' || !session.sock) {
      item.status = 'failed';
      item.error = `Session "${item.sessionId}" is not connected`;
      addLog(`Queue item ${item.id} failed: ${item.error}`, 'error');

      sentMessages.push({
        id: item.id,
        phoneNumber: item.recipient.split('@')[0],
        message: item.message || '[Media/Interactive Content]',
        timestamp: new Date().toISOString(),
        status: 'failed',
        error: item.error
      });
      continue;
    }

    try {
      await sendMessageDirectly(session.sock, item);
      item.status = 'sent';
      item.sentAt = new Date().toISOString();
      addLog(`Queue: Item ${item.id} sent successfully to ${item.recipient}`, 'success');

      let cleanPhone = item.recipient.split('@')[0];
      let displayMsg = item.message || '[Interactive Content]';
      if (item.attachmentType && item.attachmentType !== 'none') {
        displayMsg = `[${item.attachmentType.toUpperCase()}] ${displayMsg}`;
      }

      sentMessages.push({
        id: item.id,
        phoneNumber: cleanPhone,
        message: item.workflowName ? `[AUTO: ${item.workflowName}] ${displayMsg}` : displayMsg,
        timestamp: new Date().toISOString(),
        status: 'sent'
      });
    } catch (err: any) {
      item.status = 'failed';
      item.error = err.message || 'Unknown error';
      addLog(`Queue: Item ${item.id} failed for ${item.recipient}: ${item.error}`, 'error');

      sentMessages.push({
        id: item.id,
        phoneNumber: item.recipient.split('@')[0],
        message: item.message || '[Interactive Content]',
        timestamp: new Date().toISOString(),
        status: 'failed',
        error: item.error
      });
    }

    if (messageQueue.some(i => i.status === 'pending')) {
      addLog(`Queue: Waiting ${globalDelaySeconds}s delay to throttle outgoing messages...`, 'info');
      await new Promise(resolve => setTimeout(resolve, globalDelaySeconds * 1000));
    }
  }

  isProcessingQueue = false;
}

async function sendMessageDirectly(sockInstance: any, item: QueueItem) {
  const {
    recipient,
    messageType,
    message,
    footer,
    attachmentType = 'none',
    attachmentUrl,
    attachmentData,
    attachmentName,
    inlineAttachment = false,
    buttons,
    templateButtons
  } = item;

  let targetJid = recipient.trim();
  let tempFilePath: string | null = null;

  try {
    let fileRef: any = null;
    if (attachmentType && attachmentType !== 'none') {
      if (attachmentData) {
        let buffer: Buffer;
        if (attachmentData.includes(';base64,')) {
          const parts = attachmentData.split(';base64,');
          buffer = Buffer.from(parts[1], 'base64');
        } else {
          buffer = Buffer.from(attachmentData, 'base64');
        }

        const tempDir = path.join(process.cwd(), 'temp_attachments');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        tempFilePath = path.join(tempDir, `${Date.now()}_${attachmentName || 'file'}`);
        fs.writeFileSync(tempFilePath, buffer);
        fileRef = { url: tempFilePath };
      } else if (attachmentUrl) {
        fileRef = { url: attachmentUrl };
      }
    }

    const hasAttachment = !!fileRef;
    let mediaObject: any = null;

    if (hasAttachment && inlineAttachment && messageType !== 'text') {
      try {
        let mediaObjPayload: any = {};
        if (attachmentType === 'image') {
          mediaObjPayload = { image: fileRef };
        } else if (attachmentType === 'video') {
          mediaObjPayload = { video: fileRef };
        } else if (attachmentType === 'pdf' || attachmentType === 'doc') {
          const mime = attachmentType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const filename = attachmentName || (attachmentType === 'pdf' ? 'document.pdf' : 'document.docx');
          mediaObjPayload = { document: fileRef, mimetype: mime, fileName: filename };
        }
        mediaObject = await prepareWAMessageMedia(mediaObjPayload, { upload: sockInstance.waUploadToServer });
      } catch (err: any) {
        console.error('Failed to prepare inline attachment:', err);
      }
    }

    if (hasAttachment && messageType === 'text') {
      let mediaPayload: any = {};
      if (attachmentType === 'image') {
        mediaPayload = { image: fileRef, caption: message };
      } else if (attachmentType === 'video') {
        mediaPayload = { video: fileRef, caption: message };
      } else if (attachmentType === 'pdf' || attachmentType === 'doc') {
        const mime = attachmentType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const filename = attachmentName || (attachmentType === 'pdf' ? 'document.pdf' : 'document.docx');
        mediaPayload = { document: fileRef, mimetype: mime, fileName: filename, caption: message };
      }
      await sockInstance.sendMessage(targetJid, mediaPayload);
    } else {
      if (hasAttachment && (!inlineAttachment || !mediaObject)) {
        let mediaPayload: any = {};
        if (attachmentType === 'image') {
          mediaPayload = { image: fileRef, caption: `Attachment: ${attachmentName || 'image'}` };
        } else if (attachmentType === 'video') {
          mediaPayload = { video: fileRef, caption: `Attachment: ${attachmentName || 'video'}` };
        } else if (attachmentType === 'pdf' || attachmentType === 'doc') {
          const mime = attachmentType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const filename = attachmentName || (attachmentType === 'pdf' ? 'document.pdf' : 'document.docx');
          mediaPayload = { document: fileRef, mimetype: mime, fileName: filename, caption: `Attachment: ${filename}` };
        }
        await sockInstance.sendMessage(targetJid, mediaPayload);
      }

      let payload: any = {};
      let isInteractive = false;
      
      const headerPayload = (mediaObject) ? {
        title: '',
        hasMediaAttachment: true,
        ...mediaObject
      } : {
        title: '',
        hasMediaAttachment: false
      };

      if (messageType === 'buttons' && Array.isArray(buttons) && buttons.length > 0) {
        isInteractive = true;
        payload = {
          viewOnceMessage: {
            message: {
              interactiveMessage: {
                body: { text: message },
                footer: { text: footer || 'WhatsApp Bridge' },
                header: headerPayload,
                nativeFlowMessage: {
                  buttons: buttons.map((btn: any, index: number) => ({
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                      display_text: btn.text,
                      id: btn.id || `btn-${index}`
                    })
                  }))
                }
              }
            }
          }
        };
      } else if (messageType === 'template' && Array.isArray(templateButtons) && templateButtons.length > 0) {
        isInteractive = true;
        payload = {
          viewOnceMessage: {
            message: {
              interactiveMessage: {
                body: { text: message },
                footer: { text: footer || 'WhatsApp Bridge' },
                header: headerPayload,
                nativeFlowMessage: {
                  buttons: templateButtons.map((btn: any, index: number) => {
                    if (btn.type === 'url') {
                      return {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                          display_text: btn.text,
                          url: btn.url,
                          merchant_url: btn.url
                        })
                      };
                    } else if (btn.type === 'call') {
                      return {
                        name: 'cta_call',
                        buttonParamsJson: JSON.stringify({
                          display_text: btn.text,
                          phone_number: btn.phoneNumber
                        })
                      };
                    } else {
                      return {
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({
                          display_text: btn.text,
                          id: btn.id || `reply-${index}`
                        })
                      };
                    }
                  })
                }
              }
            }
          }
        };
      } else {
        payload = { text: message };
      }

      if (isInteractive) {
        const msg = generateWAMessageFromContent(
          targetJid,
          payload,
          { userJid: sockInstance.user?.id }
        );
        await sockInstance.relayMessage(targetJid, msg.message, { messageId: msg.key.id });
      } else {
        await sockInstance.sendMessage(targetJid, payload);
      }
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {}
    }
  }
}


export interface WorkflowRule {
  id: string;
  name: string;
  triggerType: 'button' | 'text';
  triggerValue: string; // button id or text keyword
  responseType: 'text' | 'buttons' | 'template' | 'none';
  message: string;
  footer?: string;
  attachmentType?: 'none' | 'image' | 'video' | 'pdf' | 'doc';
  attachmentUrl?: string;
  inlineAttachment?: boolean;
  buttons?: Array<{ id: string; text: string }>;
  templateButtons?: Array<{ type: 'url' | 'call' | 'quickReply'; text: string; url?: string; phoneNumber?: string; id?: string }>;
}

let workflows: WorkflowRule[] = [];
const workflowsFilePath = path.join(process.cwd(), 'workflows.json');

function loadWorkflows() {
  try {
    if (fs.existsSync(workflowsFilePath)) {
      const data = fs.readFileSync(workflowsFilePath, 'utf8');
      workflows = JSON.parse(data);
      console.log(`[WA-BRIDGE] Loaded ${workflows.length} workflows successfully from workflows.json.`);
    } else {
      // Seed with highly functional defaults representing multi-message flows
      const defaultWorkflows: WorkflowRule[] = [
        {
          id: "wf-1",
          name: "Invoice Help Responder",
          triggerType: "button",
          triggerValue: "invoice-help",
          responseType: "buttons",
          message: "We would be happy to help you with your invoice questions. Please choose an option below to proceed with your payment or talk to a billing assistant.",
          footer: "Navi Billing Support",
          attachmentType: "none",
          inlineAttachment: false,
          buttons: [
            { id: "wf-pay-now", text: "💳 Pay Right Now" },
            { id: "wf-talk-agent", text: "💬 Chat with Agent" }
          ],
          templateButtons: []
        },
        {
          id: "wf-2",
          name: "Checkout Details Bot",
          triggerType: "button",
          triggerValue: "wf-pay-now",
          responseType: "template",
          message: "Excellent choice! Click below to complete your payment securely. After paying, you'll receive a confirmation receipt instantly.",
          footer: "Navi Secure Checkout",
          attachmentType: "none",
          inlineAttachment: false,
          buttons: [],
          templateButtons: [
            { type: "url", text: "🔒 Complete Checkout", url: "https://ai.studio/build" },
            { type: "quickReply", text: "❓ Get Help", id: "invoice-help" }
          ]
        },
        {
          id: "wf-3",
          name: "Live Support Handover",
          triggerType: "button",
          triggerValue: "wf-talk-agent",
          responseType: "text",
          message: "Got it! Your billing ticket #BL-4912 has been opened. An agent from our finance department will connect with you here shortly.",
          footer: "",
          attachmentType: "none",
          inlineAttachment: false,
          buttons: [],
          templateButtons: []
        },
        {
          id: "wf-4",
          name: "View FAQs Responder",
          triggerType: "button",
          triggerValue: "faq-help",
          responseType: "buttons",
          message: "Frequently Asked Questions:\n\n1. What is Navi?\nNavi is a modular interactive message bridge.\n\n2. Are these messages secure?\nYes, fully relayed through secure WhatsApp endpoints.\n\nChoose an action below:",
          footer: "Navi Knowledge Base",
          attachmentType: "none",
          inlineAttachment: false,
          buttons: [
            { id: "wf-main-menu", text: "🏠 Main Menu" },
            { id: "wf-talk-agent", text: "📞 Connect Support" }
          ],
          templateButtons: []
        },
        {
          id: "wf-5",
          name: "Main Menu Responder",
          triggerType: "button",
          triggerValue: "wf-main-menu",
          responseType: "text",
          message: "Hi again! What can we help you with today? You can choose any of our interactive paths by interacting with the messages.",
          footer: "",
          attachmentType: "none",
          inlineAttachment: false,
          buttons: [],
          templateButtons: []
        },
        {
          id: "wf-6",
          name: "Hello Keyword Responder",
          triggerType: "text",
          triggerValue: "hello",
          responseType: "buttons",
          message: "Welcome to Navi's Interactive Automation System! 🌟\n\nHow can we support your experience today? Please select one of our self-serve paths:",
          footer: "Navi Smart Assistant",
          attachmentType: "none",
          inlineAttachment: false,
          buttons: [
            { id: "faq-help", text: "❓ View FAQs" },
            { id: "invoice-help", text: "💳 Billing Support" }
          ],
          templateButtons: []
        }
      ];
      workflows = defaultWorkflows;
      fs.writeFileSync(workflowsFilePath, JSON.stringify(defaultWorkflows, null, 2), 'utf8');
      console.log('[WA-BRIDGE] Created default workflows.json file.');
    }
  } catch (err: any) {
    console.error('[WA-BRIDGE] Error loading/saving workflows:', err.message);
  }
}

function saveWorkflowsToFile() {
  try {
    fs.writeFileSync(workflowsFilePath, JSON.stringify(workflows, null, 2), 'utf8');
    addLog(`Workflows configuration saved successfully (${workflows.length} rules)`, 'success');
    return true;
  } catch (err: any) {
    addLog(`Failed to save workflows file: ${err.message}`, 'error');
    return false;
  }
}

async function sendAutomationResponse(sock: any, targetJid: string, rule: WorkflowRule) {
  try {
    addLog(`🤖 Running Automation Workflow: "${rule.name}" for ${targetJid}...`, 'info');
    
    const msgType = rule.responseType;
    const message = rule.message;
    const footer = rule.footer;
    const attachmentType = rule.attachmentType || 'none';
    const attachmentUrl = rule.attachmentUrl;
    const inlineAttachment = rule.inlineAttachment ?? true;
    const buttons = rule.buttons || [];
    const templateButtons = rule.templateButtons || [];

    let fileRef: any = null;
    const hasAttachment = attachmentType !== 'none' && !!attachmentUrl;
    if (hasAttachment) {
      fileRef = { url: attachmentUrl };
    }

    let mediaObject: any = null;

    if (hasAttachment && inlineAttachment && msgType !== 'text') {
      try {
        let mediaObjPayload: any = {};
        if (attachmentType === 'image') {
          mediaObjPayload = { image: fileRef };
        } else if (attachmentType === 'video') {
          mediaObjPayload = { video: fileRef };
        } else if (attachmentType === 'pdf' || attachmentType === 'doc') {
          const mime = attachmentType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const filename = attachmentType === 'pdf' ? 'document.pdf' : 'document.docx';
          mediaObjPayload = { document: fileRef, mimetype: mime, fileName: filename };
        }
        addLog(`[AUTO-BOT] Uploading inline header attachment: ${attachmentType}...`, 'info');
        mediaObject = await prepareWAMessageMedia(mediaObjPayload, { upload: sock.waUploadToServer });
        addLog(`[AUTO-BOT] Inline header attachment uploaded successfully!`, 'success');
      } catch (err: any) {
        addLog(`[AUTO-BOT] Failed to upload inline header attachment: ${err.message}. Falling back to separate message delivery.`, 'error');
      }
    }

    if (hasAttachment && msgType === 'text') {
      // Send as media with text as caption
      let mediaPayload: any = {};
      if (attachmentType === 'image') {
        mediaPayload = { image: fileRef, caption: message };
      } else if (attachmentType === 'video') {
        mediaPayload = { video: fileRef, caption: message };
      } else if (attachmentType === 'pdf' || attachmentType === 'doc') {
        const mime = attachmentType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const filename = attachmentType === 'pdf' ? 'document.pdf' : 'document.docx';
        mediaPayload = { document: fileRef, caption: message, mimetype: mime, fileName: filename };
      }
      addLog(`[AUTO-BOT] Sending media file with caption...`, 'info');
      await sock.sendMessage(targetJid, mediaPayload);
    } else {
      // If there's an attachment AND interactive buttons/template, and we are not doing inline
      if (hasAttachment && (!inlineAttachment || !mediaObject)) {
        let mediaPayload: any = {};
        if (attachmentType === 'image') {
          mediaPayload = { image: fileRef, caption: `Attachment: image` };
        } else if (attachmentType === 'video') {
          mediaPayload = { video: fileRef, caption: `Attachment: video` };
        } else if (attachmentType === 'pdf' || attachmentType === 'doc') {
          const mime = attachmentType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const filename = attachmentType === 'pdf' ? 'document.pdf' : 'document.docx';
          mediaPayload = { document: fileRef, mimetype: mime, fileName: filename };
        }
        addLog(`[AUTO-BOT] Dispatching preceding media attachment...`, 'info');
        await sock.sendMessage(targetJid, mediaPayload);
      }

      // Prepare interactive payload
      let payload: any = {};
      let isInteractive = false;

      const headerPayload = (mediaObject) ? {
        title: '',
        hasMediaAttachment: true,
        ...mediaObject
      } : {
        title: '',
        hasMediaAttachment: false
      };

      if (msgType === 'buttons' && Array.isArray(buttons) && buttons.length > 0) {
        isInteractive = true;
        payload = {
          viewOnceMessage: {
            message: {
              interactiveMessage: {
                body: { text: message },
                footer: { text: footer || 'WhatsApp Bridge' },
                header: headerPayload,
                nativeFlowMessage: {
                  buttons: buttons.map((btn: any, index: number) => ({
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                      display_text: btn.text,
                      id: btn.id || `btn-${index}`
                    })
                  }))
                }
              }
            }
          }
        };
      } else if (msgType === 'template' && Array.isArray(templateButtons) && templateButtons.length > 0) {
        isInteractive = true;
        payload = {
          viewOnceMessage: {
            message: {
              interactiveMessage: {
                body: { text: message },
                footer: { text: footer || 'WhatsApp Bridge' },
                header: headerPayload,
                nativeFlowMessage: {
                  buttons: templateButtons.map((btn: any, index: number) => {
                    if (btn.type === 'url') {
                      return {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                          display_text: btn.text,
                          url: btn.url,
                          merchant_url: btn.url
                        })
                      };
                    } else if (btn.type === 'call') {
                      return {
                        name: 'cta_call',
                        buttonParamsJson: JSON.stringify({
                          display_text: btn.text,
                          phone_number: btn.phoneNumber
                        })
                      };
                    } else {
                      return {
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({
                          display_text: btn.text,
                          id: btn.id || `reply-${index}`
                        })
                      };
                    }
                  })
                }
              }
            }
          }
        };
      } else {
        payload = { text: message };
      }

      if (isInteractive) {
        const msg = generateWAMessageFromContent(
          targetJid,
          payload,
          { userJid: sock.user?.id }
        );
        await sock.relayMessage(targetJid, msg.message, { messageId: msg.key.id });
      } else {
        await sock.sendMessage(targetJid, payload);
      }
    }

    addLog(`[AUTO-BOT] Automation message sent successfully for "${rule.name}"`, 'success');

    // Add to history
    let logMsg = message || '';
    if (hasAttachment) {
      logMsg = `[Attached ${attachmentType.toUpperCase()}] ${logMsg}`;
    }
    sentMessages.push({
      id: Math.random().toString(36).substring(7),
      phoneNumber: targetJid.split('@')[0],
      message: `[AUTO-BOT: ${rule.name}] ` + (msgType === 'text' || !msgType ? logMsg : `[${msgType.toUpperCase()}] ${logMsg}`),
      timestamp: new Date().toISOString(),
      status: 'sent'
    });

  } catch (err: any) {
    addLog(`[AUTO-BOT] Failed to execute auto-response: ${err.message}`, 'error');
  }
}

function addLog(message: string, type: 'info' | 'error' | 'success' = 'info') {
  const log = {
    id: Math.random().toString(36).substring(7),
    timestamp: new Date().toISOString(),
    message,
    type
  };
  connectionLogs.push(log);
  if (connectionLogs.length > 50) {
    connectionLogs.shift();
  }
  console.log(`[WA-BRIDGE] [${type.toUpperCase()}] ${message}`);
}

async function connectToWhatsApp(id?: string, name?: string) {
  // If called without arguments, load all sessions and connect them
  if (!id) {
    const sessionConfigs = loadSessionsConfig();
    for (const conf of sessionConfigs) {
      connectToWhatsApp(conf.id, conf.name);
    }
    return;
  }

  // Ensure we initialize session state in map
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      name: name || 'WhatsApp Session',
      sock: null,
      status: 'disconnected',
      qrBase64: null,
      activePairingCode: null,
      user: null,
      lastError: null
    });
  }

  const session = sessions.get(id)!;
  session.status = 'connecting';
  session.qrBase64 = null;
  session.activePairingCode = null;

  // For global legacy variables
  if (id === 'primary') {
    connectionStatus = 'connecting';
    qrBase64 = null;
    activePairingCode = null;
  }

  try {
    const authFolder = id === 'primary' 
      ? path.join(process.cwd(), 'auth_info')
      : path.join(process.cwd(), 'sessions_auth', id);

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    addLog(`[SESSION: ${id}] Starting WhatsApp connection...`, 'info');

    const sockInstance = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' })
    });

    session.sock = sockInstance;
    if (id === 'primary') {
      sock = sockInstance;
    }

    sockInstance.ev.on('creds.update', saveCreds);

    sockInstance.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          session.qrBase64 = await QRCode.toDataURL(qr);
          addLog(`[SESSION: ${id}] New WhatsApp Web QR Code generated.`, 'info');
          
          if (id === 'primary') {
            qrBase64 = session.qrBase64;
          }
        } catch (err: any) {
          addLog(`[SESSION: ${id}] Failed to generate QR Code Base64: ${err.message}`, 'error');
        }
      }

      if (connection === 'close') {
        session.qrBase64 = null;
        session.activePairingCode = null;
        session.status = 'disconnected';
        session.user = null;

        if (id === 'primary') {
          connectionStatus = 'disconnected';
          qrBase64 = null;
          activePairingCode = null;
        }

        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const errMessage = lastDisconnect?.error?.message || 'Connection closed';
        session.lastError = errMessage;
        if (id === 'primary') {
          lastError = errMessage;
        }

        const isSessionInvalid = 
          statusCode === DisconnectReason.loggedOut || 
          statusCode === DisconnectReason.badSession || 
          statusCode === 411 ||
          errMessage.toLowerCase().includes('logged out') ||
          errMessage.toLowerCase().includes('bad session');

        if (isSessionInvalid) {
          addLog(`[SESSION: ${id}] WhatsApp session ended/invalid. Clearing credentials...`, 'info');
          try {
            if (fs.existsSync(authFolder)) {
              fs.rmSync(authFolder, { recursive: true, force: true });
            }
          } catch (e: any) {}
          setTimeout(() => connectToWhatsApp(id, name), 2000);
        } else {
          const isQrTimeout = errMessage.toLowerCase().includes('qr refs') || statusCode === 408;
          if (isQrTimeout) {
            addLog(`[SESSION: ${id}] QR scan timed out. Refreshing...`, 'info');
          } else {
            addLog(`[SESSION: ${id}] Connection paused (${errMessage}). Reconnecting in 5 seconds...`, 'info');
          }
          setTimeout(() => connectToWhatsApp(id, name), 5000);
        }
      } else if (connection === 'open') {
        session.status = 'connected';
        session.qrBase64 = null;
        session.activePairingCode = null;
        session.lastError = null;
        session.user = {
          id: sockInstance.user?.id || 'Unknown JID',
          name: sockInstance.user?.name || name || 'WhatsApp User'
        };

        if (id === 'primary') {
          connectionStatus = 'connected';
          qrBase64 = null;
          activePairingCode = null;
          lastError = null;
        }

        addLog(`[SESSION: ${id}] WhatsApp connected! JID: ${session.user.id} (${session.user.name})`, 'success');
      }
    });

    sockInstance.ev.on('messages.upsert', async (m: any) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          const from = msg.key.remoteJid;
          const isMe = msg.key.fromMe;

          const text = msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text || 
                       msg.message?.imageMessage?.caption || 
                       msg.message?.videoMessage?.caption || 
                       '';
          
          let buttonId = msg.message?.buttonsResponseMessage?.selectedButtonId || 
                         msg.message?.templateButtonReplyMessage?.selectedId;

          if (!buttonId && msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
            try {
              const params = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
              buttonId = params.id;
            } catch (e) {}
          }

          const buttonText = msg.message?.buttonsResponseMessage?.selectedDisplayText ||
                             msg.message?.templateButtonReplyMessage?.selectedDisplayText ||
                             msg.message?.interactiveResponseMessage?.selectedDisplayText;

          if (buttonId) {
            addLog(`[SESSION: ${id}] Button clicked: from=${from} buttonId="${buttonId}" buttonText="${buttonText || ''}"`, 'success');
          } else if (text) {
            addLog(`[SESSION: ${id}] Msg received: from=${from} text="${text.substring(0, 60)}"`, 'info');
          }

          // Group ID detection "getid" or "get id" or "id" or "/id" or "/getid"
          const normalizedText = text.trim().toLowerCase();
          const getidKeywords = ['getid', 'get id', 'id', '/id', '/getid'];
          if (getidKeywords.includes(normalizedText) && from) {
            const isGroup = from.endsWith('@g.us');
            if (isGroup) {
              addLog(`[SESSION: ${id}] Group JID Requested: ${from}`, 'success');
              try {
                let groupName = 'Unknown Group';
                try {
                  const meta = await sockInstance.groupMetadata(from);
                  groupName = meta.subject || 'Unknown Group';
                } catch (metaErr) {
                  console.error('Failed to fetch group metadata:', metaErr);
                }

                saveGroupDetails(from, groupName, id);

                await sockInstance.sendMessage(from, { 
                  text: `📋 *Group Saved Successfully!*\n\n• *Name:* ${groupName}\n• *JID:* ${from}\n\nThis group has been added to your Saved Groups dashboard dropdown.` 
                }, { quoted: msg });

                addLog(`[SESSION: ${id}] Saved group metadata for "${groupName}" (${from})`, 'success');
              } catch (err: any) {
                addLog(`[SESSION: ${id}] Failed to reply to group: ${err.message}`, 'error');
              }
            } else {
              addLog(`[SESSION: ${id}] Individual JID requested: ${from}`, 'success');
              try {
                await sockInstance.sendMessage(from, { text: `📋 *Your JID:* ${from}` }, { quoted: msg });
              } catch (err: any) {
                addLog(`[SESSION: ${id}] Failed to reply to user: ${err.message}`, 'error');
              }
            }
          }

          // Process Workflows - Automated response through Queue to avoid block chance
          if (!isMe && from) {
            let matchedRule: WorkflowRule | null = null;
            if (buttonId) {
              matchedRule = workflows.find(w => w.triggerType === 'button' && w.triggerValue?.trim().toLowerCase() === buttonId.trim().toLowerCase()) || null;
            }
            if (!matchedRule && text) {
              const normText = text.trim().toLowerCase();
              matchedRule = workflows.find(w => w.triggerType === 'text' && normText.includes(w.triggerValue?.trim().toLowerCase())) || null;
            }

            if (matchedRule) {
              addLog(`⚡ Matched Workflow "${matchedRule.name}". Adding auto-response to global queue for Session "${id}"...`, 'success');
              
              pushToQueue({
                recipient: from,
                recipientType: from.endsWith('@g.us') ? 'group' : 'individual',
                messageType: matchedRule.responseType,
                message: matchedRule.message,
                footer: matchedRule.footer,
                attachmentType: matchedRule.attachmentType || 'none',
                attachmentUrl: matchedRule.attachmentUrl,
                inlineAttachment: matchedRule.inlineAttachment ?? true,
                buttons: matchedRule.buttons,
                templateButtons: matchedRule.templateButtons,
                sessionId: id,
                workflowName: matchedRule.name
              });
            }
          }
        }
      }
    });

  } catch (error: any) {
    console.error(`[SESSION: ${id}] Connection error:`, error);
    addLog(`[SESSION: ${id}] Connection error: ${error.message}`, 'error');
    session.status = 'disconnected';
    session.lastError = error.message;
    if (id === 'primary') {
      connectionStatus = 'disconnected';
      lastError = error.message;
    }
    setTimeout(() => connectToWhatsApp(id, name), 10000);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Load workflows config from disk
  loadWorkflows();

  // Initialize WhatsApp connection
  connectToWhatsApp();

  // Workflows Automation API
  app.get('/api/workflows', (req, res) => {
    res.json({ success: true, workflows });
  });

  app.post('/api/workflows', (req, res) => {
    const { workflows: newWorkflows } = req.body;
    if (!Array.isArray(newWorkflows)) {
      return res.status(400).json({ success: false, error: 'Workflows must be an array.' });
    }
    workflows = newWorkflows;
    const ok = saveWorkflowsToFile();
    if (ok) {
      res.json({ success: true, workflows, message: 'Workflows updated successfully!' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to write workflows configuration to disk.' });
    }
  });

  // API Endpoints
  app.get('/api/qr', (req, res) => {
    // Legacy QR code maps to the primary session
    const primarySess = sessions.get('primary');
    res.json({ 
      qr: primarySess ? primarySess.qrBase64 : qrBase64, 
      status: primarySess ? primarySess.status : connectionStatus 
    });
  });

  app.get('/api/status', (req, res) => {
    // Legacy status maps to primary session
    const primarySess = sessions.get('primary');
    res.json({
      connected: primarySess ? primarySess.status === 'connected' : connectionStatus === 'connected',
      status: primarySess ? primarySess.status : connectionStatus,
      error: primarySess ? primarySess.lastError : lastError,
      user: primarySess && primarySess.status === 'connected' ? primarySess.user : null,
      logs: connectionLogs,
      sentCount: sentMessages.length,
      sentHistory: sentMessages.slice(-20),
      pairingCode: primarySess ? primarySess.activePairingCode : activePairingCode
    });
  });

  // Saved Groups API
  app.get('/api/groups', (req, res) => {
    res.json({ success: true, groups: loadSavedGroups() });
  });

  app.delete('/api/groups/:jid', (req, res) => {
    const { jid } = req.params;
    deleteSavedGroup(jid);
    res.json({ success: true, message: 'Group JID removed from saved database!' });
  });

  // Multi-Session Management APIs
  app.get('/api/sessions', (req, res) => {
    const list = Array.from(sessions.values()).map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      qrBase64: s.qrBase64,
      pairingCode: s.activePairingCode,
      user: s.user,
      lastError: s.lastError
    }));
    res.json({ success: true, sessions: list });
  });

  app.post('/api/sessions/create', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) {
      return res.status(400).json({ success: false, error: 'Session JID and Name are required.' });
    }

    const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanId) {
      return res.status(400).json({ success: false, error: 'Invalid Session ID characters.' });
    }

    const config = loadSessionsConfig();
    if (config.some(c => c.id === cleanId)) {
      return res.status(400).json({ success: false, error: 'A session with this ID already exists.' });
    }

    config.push({ id: cleanId, name: name.trim() });
    saveSessionsConfig(config);

    // Bootstrap and connect session
    await connectToWhatsApp(cleanId, name.trim());
    res.json({ success: true, message: `Session "${name}" created & connecting...`, id: cleanId });
  });

  app.post('/api/sessions/request-pairing-code', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;
    if (!sessionId || !phoneNumber) {
      return res.status(400).json({ success: false, error: 'Session ID and recipient phone are required.' });
    }

    const cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber) {
      return res.status(400).json({ success: false, error: 'Invalid pairing phone number format.' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: `Session "${sessionId}" not found.` });
    }

    try {
      if (!session.sock) {
        await connectToWhatsApp(sessionId, session.name);
      }
      addLog(`[SESSION: ${sessionId}] Requesting pairing code for phone: ${cleanNumber}...`, 'info');
      const code = await session.sock.requestPairingCode(cleanNumber);
      session.activePairingCode = code;
      addLog(`[SESSION: ${sessionId}] Pairing code received successfully: ${code}`, 'success');
      res.json({ success: true, code });
    } catch (err: any) {
      addLog(`[SESSION: ${sessionId}] Failed to request pairing code: ${err.message}`, 'error');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/sessions/delete', async (req, res) => {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Session ID is required.' });
    }

    if (id === 'primary') {
      return res.status(400).json({ success: false, error: 'The Primary Account cannot be completely deleted, only logged out.' });
    }

    const session = sessions.get(id);
    if (session) {
      try {
        if (session.sock) {
          await session.sock.logout();
        }
      } catch (e) {}
      sessions.delete(id);
    }

    // Delete credentials folder from disk
    const authFolder = path.join(process.cwd(), 'sessions_auth', id);
    try {
      if (fs.existsSync(authFolder)) {
        fs.rmSync(authFolder, { recursive: true, force: true });
      }
    } catch (e) {}

    let config = loadSessionsConfig();
    config = config.filter(c => c.id !== id);
    saveSessionsConfig(config);

    addLog(`Session "${id}" was deleted and credentials folder purged.`, 'success');
    res.json({ success: true, message: `Session "${id}" successfully removed.` });
  });

  // Message Queue & Wait Timers APIs
  app.get('/api/queue', (req, res) => {
    res.json({
      success: true,
      queue: messageQueue,
      isProcessing: isProcessingQueue,
      delaySeconds: globalDelaySeconds
    });
  });

  app.post('/api/queue/clear', (req, res) => {
    messageQueue = [];
    addLog('Message Queue cleared successfully.', 'info');
    res.json({ success: true, message: 'Message Queue cleared successfully.' });
  });

  app.post('/api/queue/config', (req, res) => {
    const { delaySeconds } = req.body;
    if (typeof delaySeconds === 'number' && delaySeconds >= 0) {
      globalDelaySeconds = delaySeconds;
      addLog(`Message Queue throttle delay updated to: ${delaySeconds} seconds.`, 'success');
      res.json({ success: true, delaySeconds, message: `Delay set to ${delaySeconds} seconds.` });
    } else {
      res.status(400).json({ success: false, error: 'Invalid delay parameter.' });
    }
  });

  app.post('/api/request-pairing-code', async (req, res) => {
    // Legacy maps to primary session request
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }

    const cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber) {
      return res.status(400).json({ success: false, error: 'Invalid phone number format.' });
    }

    const primarySess = sessions.get('primary');
    if (primarySess && primarySess.status === 'connected') {
      return res.status(400).json({ success: false, error: 'Primary WhatsApp account is already connected.' });
    }

    try {
      if (!primarySess || !primarySess.sock) {
        await connectToWhatsApp('primary', 'Primary Account');
      }
      
      const session = sessions.get('primary')!;
      addLog('Requesting pairing code for primary phone...', 'info');
      const code = await session.sock.requestPairingCode(cleanNumber);
      session.activePairingCode = code;
      activePairingCode = code;
      addLog(`Primary pairing code generated: ${code}`, 'success');
      res.json({ success: true, code });
    } catch (err: any) {
      addLog(`Failed to request primary pairing code: ${err.message}`, 'error');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/send-template', async (req, res) => {
    const { phoneNumber, recipientType, sessionIds = ['primary'], splitByCommas = true } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Recipient phone number or Group JID is required' });
    }

    // Split recipient list
    let recipients: string[] = [];
    if (splitByCommas) {
      recipients = phoneNumber.split(',').map((p: string) => p.trim()).filter(Boolean);
    } else {
      recipients = phoneNumber.split('\n').map((p: string) => p.trim()).filter(Boolean);
    }

    if (recipients.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid recipients supplied.' });
    }

    // Validate sessions
    const validSessions = sessionIds.filter((sid: string) => {
      const s = sessions.get(sid);
      return s && s.status === 'connected';
    });

    if (validSessions.length === 0) {
      return res.status(400).json({ success: false, error: 'No connected sessions selected. Please select at least one connected account.' });
    }

    const addedItems = [];
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const assignedSessionId = getAssignedSessionIdForRecipient(recipient, recipientType, validSessions[i % validSessions.length], validSessions);

      let targetJid = recipient;
      if (recipientType === 'group') {
        if (!targetJid.includes('@')) {
          targetJid = `${targetJid}@g.us`;
        }
      } else {
        const cleanNumber = recipient.replace(/\D/g, '');
        if (cleanNumber) {
          targetJid = `${cleanNumber}@s.whatsapp.net`;
        }
      }

      const item = pushToQueue({
        recipient: targetJid,
        recipientType,
        messageType: 'template',
        message: 'Hello\n\nYour prepaid recharge of ₹199 for Airtel is expiring today.\n\nPay Now via Navi UPI.',
        footer: 'Secure service from Meta',
        templateButtons: [
          { type: 'url', text: '🔗 Pay Now', url: 'https://play.google.com/store/apps/details?id=com.navi.passport' }
        ],
        sessionId: assignedSessionId
      });
      addedItems.push(item);
    }

    res.json({
      success: true,
      message: `Enqueued ${recipients.length} recharge templates across ${validSessions.length} selected session(s).`,
      queuedCount: recipients.length,
      items: addedItems
    });
  });

  app.post('/api/send', async (req, res) => {
    const { 
      phoneNumber, 
      recipientType,
      message, 
      msgType, 
      footer, 
      buttons, 
      templateButtons, 
      attachmentType = 'none',
      attachmentSource = 'preset',
      attachmentUrl,
      attachmentData,
      attachmentName,
      inlineAttachment = false,
      sessionIds = ['primary'],
      splitByCommas = true
    } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Recipient phone number or Group JID is required.' });
    }

    if (!message && (attachmentType === 'none' || !attachmentType)) {
      return res.status(400).json({ success: false, error: 'Please provide either a message body or an attachment.' });
    }

    // Split recipient list
    let recipients: string[] = [];
    if (splitByCommas) {
      recipients = phoneNumber.split(',').map((p: string) => p.trim()).filter(Boolean);
    } else {
      recipients = phoneNumber.split('\n').map((p: string) => p.trim()).filter(Boolean);
    }

    if (recipients.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid recipients supplied.' });
    }

    // Validate sessions
    const validSessions = sessionIds.filter((sid: string) => {
      const s = sessions.get(sid);
      return s && s.status === 'connected';
    });

    if (validSessions.length === 0) {
      return res.status(400).json({ success: false, error: 'No connected sessions selected. Please select at least one connected account.' });
    }

    const addedItems = [];
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const assignedSessionId = getAssignedSessionIdForRecipient(recipient, recipientType, validSessions[i % validSessions.length], validSessions);

      let targetJid = recipient;
      if (recipientType === 'group') {
        if (!targetJid.includes('@')) {
          targetJid = `${targetJid}@g.us`;
        }
      } else {
        const cleanNumber = recipient.replace(/\D/g, '');
        if (cleanNumber) {
          targetJid = `${cleanNumber}@s.whatsapp.net`;
        }
      }

      const item = pushToQueue({
        recipient: targetJid,
        recipientType,
        messageType: msgType,
        message,
        footer,
        attachmentType,
        attachmentUrl,
        attachmentData,
        attachmentName,
        inlineAttachment,
        buttons,
        templateButtons,
        sessionId: assignedSessionId
      });
      addedItems.push(item);
    }

    res.json({
      success: true,
      message: `Enqueued ${recipients.length} message(s) across ${validSessions.length} selected session(s).`,
      queuedCount: recipients.length,
      items: addedItems
    });
  });

  app.post('/api/logout', async (req, res) => {
    // Logout primary legacy connection
    try {
      addLog('Logging out and purging session credentials...', 'info');
      const primarySess = sessions.get('primary');
      if (primarySess && primarySess.sock) {
        await primarySess.sock.logout();
      }
    } catch (e: any) {
      addLog(`Logout warning: ${e.message}`, 'info');
    }

    try {
      const authFolder = path.join(process.cwd(), 'auth_info');
      fs.rmSync(authFolder, { recursive: true, force: true });
      addLog('Auth credentials purged successfully.', 'success');
    } catch (e: any) {
      addLog(`Failed to clean auth directory: ${e.message}`, 'error');
    }

    const primarySess = sessions.get('primary');
    if (primarySess) {
      primarySess.status = 'disconnected';
      primarySess.qrBase64 = null;
      primarySess.activePairingCode = null;
      primarySess.user = null;
    }

    connectionStatus = 'disconnected';
    qrBase64 = null;
    activePairingCode = null;
    sock = null;

    // Trigger re-connect to start fresh QR generation
    setTimeout(() => connectToWhatsApp('primary', 'Primary Account'), 1000);

    res.json({ success: true, message: 'Successfully logged out and session reset.' });
  });

  // Serve Vite / static client files
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    addLog(`WhatsApp Web Bridge running on port ${PORT}`, 'success');
  });
}

startServer().catch((err) => {
  console.error('Fatal: Server startup failed:', err);
});
