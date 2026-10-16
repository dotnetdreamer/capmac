# frozen_string_literal: true

# Export the project CocoaPods actually generated, after all Podfile hooks ran.
# This deliberately does not interpret podspecs or replace CocoaPods' resolver.
require 'json'
require 'pathname'
require 'shellwords'
require 'rexml/document'
require 'xcodeproj'

module CapMacPods
  VARIABLE = /\$\(([^)]+)\)|\$\{([^}]+)\}/
  PRODUCT_TYPES = {
    'com.apple.product-type.application' => 'application',
    'com.apple.product-type.app-extension' => 'appExtension',
    'com.apple.product-type.framework' => 'framework',
    'com.apple.product-type.library.static' => 'staticLibrary',
    'com.apple.product-type.bundle' => 'bundle'
  }.freeze

  def self.merge_settings(parent, child)
    result = parent.dup
    child.each do |key, value|
      inherited = result[key]
      result[key] = if value.is_a?(Array)
                      value.flat_map { |item| %w[$(inherited) ${inherited}].include?(item) ? Array(inherited) : item }
                    else
                      value.to_s.gsub(/\$\(inherited\)|\$\{inherited\}/, Array(inherited).join(' '))
                    end
    end
    result
  end

  def self.conditioned(settings, configuration)
    values = { 'sdk' => 'iphoneos', 'arch' => 'arm64', 'config' => configuration }
    plain, conditional = settings.partition { |key, _| !key.include?('[') }
    result = plain.to_h
    conditional.each do |key, value|
      filters = key.scan(/\[([^=\]]+)=([^\]]+)\]/)
      next unless filters.all? { |kind, pattern| values[kind] && File.fnmatch(pattern, values[kind]) }
      result[key.sub(/\[.*\]\z/, '')] = value
    end
    result
  end

  def self.layer(configuration, name)
    return {} unless configuration
    reference = configuration.base_configuration_reference
    xcconfig = reference && reference.real_path.file? ? Xcodeproj::Config.new(reference.real_path).to_hash : {}
    merge_settings(conditioned(xcconfig, name), conditioned(configuration.build_settings, name))
  end

  def self.expand(value, settings, stack = [])
    return value.map { |item| expand(item, settings, stack) } if value.is_a?(Array)
    value.to_s.gsub(VARIABLE) do |token|
      expression = Regexp.last_match(1) || Regexp.last_match(2)
      key, modifier = expression.split(':', 2)
      next token unless settings.key?(key) && !stack.include?(key)
      replacement = Array(expand(settings[key], settings, stack + [key])).join(' ')
      case modifier
      when 'rfc1034identifier' then replacement.gsub(/[^A-Za-z0-9.-]/, '-')
      when 'c99extidentifier'
        replacement = replacement.gsub(/[^A-Za-z0-9_]/, '_')
        replacement.match?(/\A[0-9]/) ? "_#{replacement}" : replacement
      when nil then replacement
      else token # Keep unsupported Xcode substitutions visible to the executor.
      end
    end
  end

  def self.settings_for(target, configuration, pods_root, sdk_path)
    project = target.project
    project_config = project.build_configurations.find { |item| item.name == configuration }
    target_config = target.build_configurations.find { |item| item.name == configuration }
    raise "Target #{target.name} has no #{configuration} configuration" unless target_config
    defaults = {
      'SRCROOT' => project.project_dir.to_s, 'SOURCE_ROOT' => project.project_dir.to_s,
      'PROJECT_DIR' => project.project_dir.to_s, 'PROJECT_FILE_PATH' => project.path.to_s,
      'PROJECT_NAME' => project.path.basename('.xcodeproj').to_s,
      'DEVELOPMENT_LANGUAGE' => project.root_object.development_region || 'en',
      'TARGET_NAME' => target.name, 'PRODUCT_NAME' => target.name,
      'CONFIGURATION' => configuration, 'PLATFORM_NAME' => 'iphoneos',
      'EFFECTIVE_PLATFORM_NAME' => '-iphoneos', 'CURRENT_ARCH' => 'arm64', 'ARCHS' => 'arm64',
      'PODS_ROOT' => pods_root, 'SDKROOT' => sdk_path,
      'PRODUCT_MODULE_NAME' => '$(PRODUCT_NAME:c99extidentifier)'
    }
    values = merge_settings(merge_settings(defaults, layer(project_config, configuration)), layer(target_config, configuration))
    # SDKROOT can be the Xcode SDK identifier rather than an absolute location.
    values['SDKROOT'] = sdk_path if values['SDKROOT'] == 'iphoneos'
    values.transform_values { |value| expand(value, values) }
  end

  def self.file_path(reference, settings)
    return nil unless reference
    tree = reference.respond_to?(:source_tree) ? reference.source_tree : '<group>'
    raw = reference.respond_to?(:path) ? reference.path : nil
    value = case tree
            when 'BUILT_PRODUCTS_DIR' then "$(BUILT_PRODUCTS_DIR)/#{raw}"
            when 'SDKROOT' then "$(SDKROOT)/#{raw}"
            when 'DEVELOPER_DIR'
              # CocoaPods writes system frameworks against its known Xcode SDK
              # layout. Resolve those references through the selected device
              # SDK rather than requiring an Xcode installation on Linux.
              match = raw.to_s.match(/\APlatforms\/iPhoneOS\.platform\/Developer\/SDKs\/iPhoneOS[0-9.]*\.sdk\/(System\/Library\/Frameworks\/.+|usr\/lib\/.+)\z/)
              match ? "$(SDKROOT)/#{match[1]}" : reference.real_path.to_s
            when '<absolute>' then raw
            else reference.real_path.to_s
            end
    expand(value, settings)
  end

  def self.flags(build_file)
    Shellwords.split((build_file.settings || {})['COMPILER_FLAGS'].to_s)
  end

  def self.target_id(target)
    "#{target.project.path}:#{target.uuid}"
  end

  def self.select_application(targets, pod_dir, scheme)
    applications = targets.select { |target| target['productType'] == 'application' }
    unless scheme.to_s.empty?
      raise 'The scheme name contains a path or control character' if scheme.match?(/[\\\/\x00\r\n]/) || %w[. ..].include?(scheme)
      scheme_files = Dir.glob(File.join(pod_dir, '**', 'xcschemes', '*.xcscheme')).select { |file| File.basename(file) == "#{scheme}.xcscheme" }
      unless scheme_files.empty?
        selected = scheme_files.flat_map do |file|
          container = Pathname.new(file).ascend.find { |directory| directory.extname == '.xcodeproj' || directory.extname == '.xcworkspace' }
          base = container ? container.dirname.to_s : pod_dir
          document = REXML::Document.new(File.read(file))
          REXML::XPath.match(document, '/Scheme/BuildAction/BuildActionEntries/BuildActionEntry').flat_map do |entry|
            next [] if entry.attributes['buildForRunning'] == 'NO'
            reference = entry.elements['BuildableReference']
            next [] unless reference
            uuid = reference.attributes['BlueprintIdentifier']
            project = reference.attributes['ReferencedContainer'].to_s.sub(/\Acontainer:/, '')
            project = File.expand_path(project, base) unless project.empty?
            applications.select { |target| target['id'] == "#{project}:#{uuid}" }
          end
        end.uniq { |target| target['id'] }
        raise "Scheme #{scheme} does not select exactly one runnable application target" unless selected.length == 1
        return selected.first
      end
      # Some generated projects rely on Xcode's automatic target-named schemes.
      selected = applications.select { |target| target['name'] == scheme }
      raise "Unknown or ambiguous application scheme #{scheme}; select an existing shared/user scheme or application target" unless selected.length == 1
      return selected.first
    end
    raise 'Select an application with --scheme; the CocoaPods workspace contains multiple apps' unless applications.length == 1
    applications.first
  end

  def self.export(request)
    root = File.expand_path(request.fetch('projectRoot'))
    pod_dir = File.expand_path(request['projectDirectory'] || request.fetch('podDirectory'))
    configuration = request.fetch('configuration', 'Debug')
    sdk_path = request.fetch('sdkPath', '$(SDKROOT)')
    project_paths = Dir.glob(File.join(pod_dir, '**', '*.xcodeproj')).sort
    project_paths.reject! { |file| Pathname.new(file).each_filename.include?('Pods') } if request['swiftPackages']
    projects = project_paths.map { |file| Xcodeproj::Project.open(file) }
    raise "No Xcode projects found in #{pod_dir}" if projects.empty?
    native_targets = projects.flat_map(&:targets).reject do |target|
      target.respond_to?(:product_type) && target.product_type.to_s.match?(/\.bundle\.(unit-test|ui-testing)\z/)
    end
    by_uuid = native_targets.group_by(&:uuid)
    targets = native_targets.map do |target|
      settings = settings_for(target, configuration, File.join(pod_dir, 'Pods'), sdk_path)
      if request['xcodeVersion']
        version = request['xcodeVersion'].to_s
        raise 'Invalid Xcode version metadata' unless version.match?(/\A\d+\.\d+(?:\.\d+)?\z/)
        major, minor, patch = version.split('.').map(&:to_i)
        settings['XCODE_VERSION_ACTUAL'] = format('%04d', major * 100 + minor * 10 + (patch || 0))
        settings['XCODE_VERSION_MAJOR'] = format('%04d', major * 100)
        settings['XCODE_VERSION_MINOR'] = format('%04d', major * 100 + minor * 10)
        settings['CAPMAC_XCODE_VERSION'] = version
        settings['XCODE_PRODUCT_BUILD_VERSION'] = request.fetch('xcodeBuild', '')
      end
      aggregate = target.isa == 'PBXAggregateTarget'
      kind = aggregate ? 'aggregate' : PRODUCT_TYPES[target.product_type]
      raise "Unsupported product type #{target.product_type} for #{target.name}; CapMac must implement it before building this project" unless kind
      phases = target.build_phases
      sources_index = phases.index { |phase| phase.isa == 'PBXSourcesBuildPhase' } || phases.length
      resources_index = phases.index { |phase| phase.isa == 'PBXResourcesBuildPhase' } || phases.length
      sources = []
      resources = []
      public_headers = []
      private_headers = []
      frameworks = []
      scripts = []
      phases.each_with_index do |phase, phase_index|
        case phase.isa
        when 'PBXSourcesBuildPhase'
          phase.files.each do |file|
            sources << { 'path' => file_path(file.file_ref, settings), 'flags' => flags(file) } if file.file_ref
          end
        when 'PBXHeadersBuildPhase'
          phase.files.each do |file|
            next unless file.file_ref
            destination = Array((file.settings || {})['ATTRIBUTES']).include?('Public') ? public_headers : private_headers
            destination << file_path(file.file_ref, settings)
          end
        when 'PBXResourcesBuildPhase'
          phase.files.each do |file|
            reference = file.file_ref
            next unless reference
            if reference.isa == 'PBXVariantGroup'
              reference.children.each do |child|
                source = file_path(child, settings)
                resources << { 'source' => source, 'destination' => "#{child.name}.lproj/#{reference.name || File.basename(source)}" }
              end
            else
              resources << { 'source' => file_path(reference, settings) }
            end
          end
        when 'PBXFrameworksBuildPhase', 'PBXCopyFilesBuildPhase'
          phase.files.each do |file|
            next unless file.file_ref
            source = file_path(file.file_ref, settings)
            if source.end_with?('.framework', '.xcframework', '.a', '.dylib', '.tbd')
              frameworks << { 'path' => source, 'weak' => Array((file.settings || {})['ATTRIBUTES']).include?('Weak'),
                              'embed' => phase.isa == 'PBXCopyFilesBuildPhase' }
            elsif source.end_with?('.appex')
              # The graph executor embeds and signs extension target products.
              next
            elsif phase.isa == 'PBXCopyFilesBuildPhase'
              # Keep copy destinations explicit, including custom native assets.
              resources << { 'source' => source, 'destination' => [phase.dst_path, File.basename(source)].reject { |v| v.to_s.empty? }.join('/') }
            end
          end
        when 'PBXShellScriptBuildPhase'
          timing = phase_index < sources_index ? 'beforeCompile' : phase_index > resources_index ? 'afterResources' : 'afterCompile'
          scripts << {
            'name' => phase.name || 'Run Script', 'script' => phase.shell_script || '', 'shellPath' => phase.shell_path || '/bin/sh',
            'timing' => timing,
            'inputPaths' => Array(phase.input_paths).map { |value| expand(value, settings) },
            'outputPaths' => Array(phase.output_paths).map { |value| expand(value, settings) },
            'inputFileListPaths' => Array(phase.input_file_list_paths).map { |value| expand(value, settings) },
            'outputFileListPaths' => Array(phase.output_file_list_paths).map { |value| expand(value, settings) }
          }
        when 'PBXRezBuildPhase'
          raise "Target #{target.name} contains a Rez phase, which needs a configured compatible resource compiler"
        end
      end
      dependencies = target.dependencies.filter_map do |dependency|
        if dependency.target
          target_id(dependency.target)
        elsif dependency.target_proxy
          candidates = by_uuid[dependency.target_proxy.remote_global_id_string] || []
          raise "Ambiguous cross-project dependency in #{target.name}" if candidates.length > 1
          target_id(candidates.first) if candidates.first
        end
      end
      product = aggregate ? target.name : target.product_reference&.path
      product ||= case kind
                  when 'framework' then "#{settings['PRODUCT_NAME']}.framework"
                  when 'staticLibrary' then "lib#{settings['PRODUCT_NAME']}.a"
                  when 'bundle' then "#{settings['PRODUCT_NAME']}.bundle"
                  else "#{settings['PRODUCT_NAME']}.app"
                  end
      {
        'id' => target_id(target), 'name' => target.name, 'productType' => kind,
        'productName' => expand(product, settings), 'moduleName' => settings['PRODUCT_MODULE_NAME'],
        'dependencies' => dependencies, 'sourceFiles' => sources, 'settings' => settings,
        'publicHeaders' => public_headers, 'privateHeaders' => private_headers,
        'resources' => resources, 'frameworks' => frameworks, 'scripts' => scripts,
        'packageProducts' => target.respond_to?(:package_product_dependencies) ? target.package_product_dependencies.map do |dependency|
          package = dependency.package
          { 'name' => dependency.product_name,
            'location' => package && package.respond_to?(:repositoryURL) ? package.repositoryURL : nil,
            'path' => package && package.respond_to?(:relative_path) ? File.expand_path(package.relative_path, target.project.project_dir) : nil }
        end : []
      }
    end
    # Xcode resolves framework references and OTHER_LDFLAGS as implicit target
    # dependencies. CocoaPods commonly links Pods-App through this mechanism.
    targets.each do |target|
      references = target['frameworks'].map { |item| File.basename(item['path']) }
      linker_flags = Array(target['settings']['OTHER_LDFLAGS']).join(' ')
      targets.each do |dependency|
        next if dependency.equal?(target) || !%w[framework staticLibrary].include?(dependency['productType'])
        product = dependency['productName']
        module_name = dependency['moduleName']
        linked = references.include?(product) || linker_flags.match?(/(?:-framework\s+["']?#{Regexp.escape(module_name)}["']?(?:\s|\z))|(?:-l["']?#{Regexp.escape(product.sub(/\Alib/, '').sub(/\.a\z/, ''))}["']?(?:\s|\z))/)
        target['dependencies'] << dependency['id'] if linked
      end
      target['dependencies'].uniq!
      target['resources'].each do |resource|
        next unless resource['source'].start_with?('$(BUILT_PRODUCTS_DIR)/')
        product = resource['source'].delete_prefix('$(BUILT_PRODUCTS_DIR)/')
        producers = targets.select { |candidate| candidate['productName'] == product }
        raise "Ambiguous generated resource #{product} in #{target['name']}" if producers.length > 1
        next unless producers.length == 1
        producer = producers.first
        resource['source'] = "#{producer['settings']['CONFIGURATION_BUILD_DIR'] || '$(BUILT_PRODUCTS_DIR)'}/#{product}"
        target['dependencies'] << producer['id'] unless target.equal?(producer) || target['dependencies'].include?(producer['id'])
      end
    end
    selected = select_application(targets, pod_dir, request['scheme'])
    if request['liveUrl']
      config_files = selected['resources'].select { |resource| File.basename(resource['source']) == 'capacitor.config.json' }
      raise 'The application resources do not include capacitor.config.json; run cap copy ios first' if config_files.empty?
      config_files.each do |resource|
        file = resource['source']
        config = JSON.parse(File.read(file))
        config['server'] = (config['server'] || {}).merge('url' => request['liveUrl'], 'cleartext' => request['liveUrl'].start_with?('http://'))
        File.write(file, JSON.pretty_generate(config) + "\n")
      end
      info_path = selected['settings']['INFOPLIST_FILE']
      if info_path && !info_path.empty?
        info_path = File.expand_path(info_path, selected['settings']['SRCROOT'])
        info = Xcodeproj::Plist.read_from_path(info_path)
        info['NSLocalNetworkUsageDescription'] ||= 'Connect to your development server for live reload.'
        info['NSAppTransportSecurity'] = (info['NSAppTransportSecurity'] || {}).merge(
          'NSAllowsLocalNetworking' => true, 'NSAllowsArbitraryLoadsInWebContent' => true
        )
        Xcodeproj::Plist.write_to_path(info, info_path)
      end
    end
    packages = projects.flat_map do |project|
      project.root_object.package_references.map do |reference|
        if reference.respond_to?(:relative_path)
          { 'path' => File.expand_path(reference.relative_path, project.project_dir) }
        else
          { 'location' => reference.repositoryURL }
        end
      end
    end
    { 'version' => 1, 'projectRoot' => root, 'rootTargetId' => selected['id'], 'targets' => targets,
      'configuration' => configuration, 'sdk' => 'iphoneos', 'swiftPackages' => request['swiftPackages'] ? packages : [],
      'projectFiles' => projects.map { |project| project.path.to_s } }
  end
end

if $PROGRAM_NAME == __FILE__
  request = JSON.parse($stdin.read)
  File.write(request.fetch('output'), JSON.pretty_generate(CapMacPods.export(request)) + "\n")
end
