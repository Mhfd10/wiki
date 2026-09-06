<template lang='pug'>
  div
    page-selector(
      mode='move'
      v-model='isShown'
      :open-handler='movePage'
      :path='pagePath'
      :locale='pageLocale'
    )
    v-dialog(v-model='historicalPathDialog', persistent, max-width='640')
      v-card
        v-card-title.warning.white--text
          v-icon.mr-3(dark) mdi-alert
          span {{ $t('common:pageRedirect.title', { defaultValue: "Previously used page path" }) }}
        v-card-text.pt-5
          p {{ $t('common:pageRedirect.moveDestination', { defaultValue: "This destination is currently a redirect to a moved page:" }) }} #[strong /{{moveTarget.locale}}/{{moveTarget.path}}]
          p.mb-0 {{ $t('common:pageRedirect.moveWarning', { defaultValue: "Moving this page here removes the redirect. External links and bookmarks using this address will open this page instead. Matching internal links in Markdown pages will be updated to the original destination." }) }}
        v-card-actions
          v-spacer
          v-btn(text, @click='historicalPathDialog = false', :disabled='loading', data-testid='keep-redirect') {{ $t('common:pageRedirect.keep', { defaultValue: "Keep redirect" }) }}
          v-btn(color='warning', @click='confirmHistoricalPath', :loading='loading', data-testid='replace-redirect-and-move') {{ $t('common:pageRedirect.replaceAndMove', { defaultValue: "Replace redirect and move" }) }}
</template>

<script>
import _ from 'lodash'
import { get } from 'vuex-pathify'

import movePageMutation from 'gql/common/common-pages-mutation-move.gql'

export default {
  props: {
    value: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      historicalPathDialog: false,
      loading: false,
      moveTarget: {
        locale: '',
        path: ''
      }
    }
  },
  computed: {
    isShown: {
      get() { return this.value },
      set(val) { this.$emit('input', val) }
    },
    pageId: get('page/id'),
    pagePath: get('page/path'),
    pageLocale: get('page/locale')
  },
  methods: {
    async movePage ({ path, locale }, reuseHistoricalPath = false) {
      this.loading = true
      this.$store.commit(`loadingStart`, 'page-move')
      try {
        const resp = await this.$apollo.mutate({
          mutation: movePageMutation,
          variables: {
            id: this.pageId,
            destinationLocale: locale,
            destinationPath: path,
            reuseHistoricalPath
          }
        })
        const result = _.get(resp, 'data.pages.move.responseResult', {})
        if (result.succeeded) {
          window.location.replace(`/${locale}/${path}`)
        } else if (result.slug === 'PageHistoricalPathCollision' && !reuseHistoricalPath) {
          this.moveTarget = { path, locale }
          this.historicalPathDialog = true
        } else {
          throw new Error(result.message || this.$t('common:error.unexpected'))
        }
      } catch (err) {
        this.$store.commit('pushGraphError', err)
      } finally {
        this.$store.commit(`loadingStop`, 'page-move')
        this.loading = false
      }
    },
    confirmHistoricalPath () {
      this.historicalPathDialog = false
      this.movePage(this.moveTarget, true)
    }
  }
}
</script>

<style lang='scss'>

</style>
